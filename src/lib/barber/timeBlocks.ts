// Per-barber time-off blocks — the storage + filter primitives that
// power the "Time off" tab on /barber/dashboard and the post-filter
// inside searchAvailability().
//
// Two block shapes:
//   - OneOffBlock: a single UTC interval (e.g. "Tue 4 Jun, 10:00-11:00").
//   - RecurringBlock: weekly rule keyed by shop-local time-of-day
//     (e.g. "Mon, Wed, Fri 12:00-13:00 starting 2026-05-01"), expanded
//     to a concrete UTC interval on demand for the specific date a
//     slot falls on. Storing shop-local time means "lunch 12-1" stays
//     12-1 across DST shifts — the existing localDateToUtc() helper
//     re-anchors the rule per-date.
//
// Storage shape: single Redis key per barber, JSON-encoded
//   mc:barber:blocks:{teamMemberId}  →  { oneOff: [...], recurring: [...] }
//
// All exports server-only.

import { Redis } from '@upstash/redis';
import { localDateToUtc } from '../square/availability';

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (_redis) return _redis;
  if (typeof window !== 'undefined') {
    throw new Error('Upstash Redis is server-only.');
  }
  const url =
    import.meta.env.UPSTASH_REDIS_REST_URL ??
    import.meta.env.KV_REST_API_URL ??
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.KV_REST_API_URL;
  const token =
    import.meta.env.UPSTASH_REDIS_REST_TOKEN ??
    import.meta.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Upstash Redis is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.',
    );
  }
  _redis = new Redis({ url: String(url), token: String(token) });
  return _redis;
}

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const WEEKDAY_ORDER: WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_SET = new Set<WeekdayKey>(WEEKDAY_ORDER);

export interface OneOffBlock {
  id: string;
  startUtc: string; // ISO UTC
  endUtc: string;   // ISO UTC, strictly > startUtc
  note?: string;
  createdAt: string;
}

export interface RecurringBlock {
  id: string;
  startTimeShop: string;     // "HH:MM" 24h shop-local
  endTimeShop: string;       // "HH:MM" 24h, > startTimeShop
  daysOfWeek: WeekdayKey[];  // non-empty
  startsOn: string;          // YYYY-MM-DD shop-local
  endsOn?: string;           // YYYY-MM-DD shop-local; absent → forever
  note?: string;
  createdAt: string;
}

export interface BlockBundle {
  oneOff: OneOffBlock[];
  recurring: RecurringBlock[];
}

function kBlocks(barberId: string): string {
  return `mc:barber:blocks:${barberId}`;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hex}`;
}

const HHMM_RE = /^([0-1]\d|2[0-3]):([0-5]\d)$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseHHMM(hhmm: string): { hour: number; minute: number } | null {
  const m = HHMM_RE.exec(hhmm);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function compareHHMM(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Load this barber's bundle. Prunes one-off blocks whose endUtc has
 *  passed (read-time pruning so Redis doesn't grow forever; the
 *  in-place write is best-effort). */
export async function listBlocks(barberId: string): Promise<BlockBundle> {
  const redis = getRedis();
  let bundle: BlockBundle;
  try {
    const raw = await redis.get<BlockBundle>(kBlocks(barberId));
    bundle = raw && typeof raw === 'object'
      ? { oneOff: raw.oneOff ?? [], recurring: raw.recurring ?? [] }
      : { oneOff: [], recurring: [] };
  } catch {
    return { oneOff: [], recurring: [] };
  }

  const now = Date.now();
  const livingOneOff = bundle.oneOff.filter((b) => {
    const end = new Date(b.endUtc).getTime();
    return !isNaN(end) && end > now;
  });
  // Same for recurring rules whose endsOn is fully in the past.
  const today = todayShopYmd();
  const livingRecurring = bundle.recurring.filter((r) =>
    !r.endsOn || r.endsOn >= today,
  );
  if (
    livingOneOff.length !== bundle.oneOff.length ||
    livingRecurring.length !== bundle.recurring.length
  ) {
    // Best-effort prune. Fire-and-forget — if it fails the next
    // read prunes again.
    redis
      .set(kBlocks(barberId), { oneOff: livingOneOff, recurring: livingRecurring })
      .catch(() => undefined);
  }
  return { oneOff: livingOneOff, recurring: livingRecurring };
}

function todayShopYmd(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface AddOneOffInput {
  startUtc: string;
  endUtc: string;
  note?: string;
}

/** Validates + appends a one-off block. Throws on validation errors
 *  so the calling endpoint can surface a friendly 400. */
export async function addOneOffBlock(
  barberId: string,
  input: AddOneOffInput,
): Promise<OneOffBlock> {
  const startMs = Date.parse(input.startUtc);
  const endMs = Date.parse(input.endUtc);
  if (isNaN(startMs)) throw new Error('startUtc is not a valid ISO date.');
  if (isNaN(endMs)) throw new Error('endUtc is not a valid ISO date.');
  if (endMs <= startMs) throw new Error('endUtc must be strictly after startUtc.');
  if (endMs <= Date.now()) {
    throw new Error("Can't add a block that's already in the past.");
  }
  if (input.note !== undefined && input.note.length > 200) {
    throw new Error('Note is too long (max 200 chars).');
  }
  const block: OneOffBlock = {
    id: randomId('mc-blk'),
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  const bundle = await listBlocks(barberId);
  bundle.oneOff = [...bundle.oneOff, block];
  await getRedis().set(kBlocks(barberId), bundle);
  return block;
}

export interface AddRecurringInput {
  startTimeShop: string;
  endTimeShop: string;
  daysOfWeek: string[];
  startsOn: string;
  endsOn?: string;
  note?: string;
}

export async function addRecurringBlock(
  barberId: string,
  input: AddRecurringInput,
): Promise<RecurringBlock> {
  if (!parseHHMM(input.startTimeShop)) {
    throw new Error('startTimeShop must be HH:MM (24h).');
  }
  if (!parseHHMM(input.endTimeShop)) {
    throw new Error('endTimeShop must be HH:MM (24h).');
  }
  if (compareHHMM(input.endTimeShop, input.startTimeShop) <= 0) {
    throw new Error('endTimeShop must be after startTimeShop.');
  }
  const days = Array.from(new Set(input.daysOfWeek.map((d) => d.toLowerCase()))).filter(
    (d): d is WeekdayKey => WEEKDAY_SET.has(d as WeekdayKey),
  );
  if (days.length === 0) {
    throw new Error('Pick at least one day of the week.');
  }
  if (!YMD_RE.test(input.startsOn)) {
    throw new Error('startsOn must be YYYY-MM-DD.');
  }
  if (input.endsOn !== undefined && input.endsOn !== '' && !YMD_RE.test(input.endsOn)) {
    throw new Error('endsOn must be YYYY-MM-DD.');
  }
  if (input.endsOn && input.endsOn < input.startsOn) {
    throw new Error('endsOn must be on or after startsOn.');
  }
  if (input.note !== undefined && input.note.length > 200) {
    throw new Error('Note is too long (max 200 chars).');
  }
  // Sort daysOfWeek into a stable display order.
  days.sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
  const block: RecurringBlock = {
    id: randomId('mc-rec'),
    startTimeShop: input.startTimeShop,
    endTimeShop: input.endTimeShop,
    daysOfWeek: days,
    startsOn: input.startsOn,
    endsOn: input.endsOn || undefined,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  const bundle = await listBlocks(barberId);
  bundle.recurring = [...bundle.recurring, block];
  await getRedis().set(kBlocks(barberId), bundle);
  return block;
}

/** Removes any block by id (one-off or recurring). Returns true if
 *  something was found and removed. */
export async function removeBlock(barberId: string, blockId: string): Promise<boolean> {
  const bundle = await listBlocks(barberId);
  const beforeOne = bundle.oneOff.length;
  const beforeRec = bundle.recurring.length;
  bundle.oneOff = bundle.oneOff.filter((b) => b.id !== blockId);
  bundle.recurring = bundle.recurring.filter((b) => b.id !== blockId);
  const removed =
    bundle.oneOff.length < beforeOne || bundle.recurring.length < beforeRec;
  if (removed) {
    await getRedis().set(kBlocks(barberId), bundle);
  }
  return removed;
}

// ---------- Slot-overlap helpers ----------

const SHOP_WEEKDAY_INDEX: Record<string, WeekdayKey> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sat', // Sundays should never be a Square slot (shop closed),
              // but if they ever are, default to 'sat' would never
              // match a recurring rule (Sunday isn't a valid pick).
};

interface ParsedShopParts {
  ymd: string;     // YYYY-MM-DD
  weekday: WeekdayKey | null;
  year: number;
  month: number;
  day: number;
}

function parseShopParts(utcIso: string): ParsedShopParts | null {
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(get('year'));
  const m = Number(get('month'));
  const day = Number(get('day'));
  if (!y || !m || !day) return null;
  const weekdayLabel = get('weekday');
  const weekday = SHOP_WEEKDAY_INDEX[weekdayLabel] ?? null;
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: weekday === 'sat' && weekdayLabel === 'Sun' ? null : weekday,
    year: y,
    month: m,
    day,
  };
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * True when a Square availability slot starting at `startAtUtc` for
 * `durationMinutes` overlaps any block in `bundle`. Pure; safe to
 * call inside a hot loop.
 */
export function slotIsBlocked(
  slot: { startAtUtc: string; durationMinutes: number },
  bundle: BlockBundle,
): boolean {
  const startMs = Date.parse(slot.startAtUtc);
  if (isNaN(startMs)) return false;
  const endMs = startMs + (slot.durationMinutes || 30) * 60_000;

  // One-off overlaps.
  for (const b of bundle.oneOff) {
    const bs = Date.parse(b.startUtc);
    const be = Date.parse(b.endUtc);
    if (isNaN(bs) || isNaN(be)) continue;
    if (rangesOverlap(startMs, endMs, bs, be)) return true;
  }

  // Recurring: build the rule's UTC interval for this slot's
  // shop-local date and test overlap.
  if (bundle.recurring.length === 0) return false;
  const shop = parseShopParts(slot.startAtUtc);
  if (!shop || !shop.weekday) return false;

  for (const r of bundle.recurring) {
    if (!r.daysOfWeek.includes(shop.weekday)) continue;
    if (shop.ymd < r.startsOn) continue;
    if (r.endsOn && shop.ymd > r.endsOn) continue;
    const start = parseHHMM(r.startTimeShop);
    const end = parseHHMM(r.endTimeShop);
    if (!start || !end) continue;
    const blockStart = localDateToUtc(
      shop.year,
      shop.month,
      shop.day,
      start.hour,
      start.minute,
    ).getTime();
    const blockEnd = localDateToUtc(
      shop.year,
      shop.month,
      shop.day,
      end.hour,
      end.minute,
    ).getTime();
    if (rangesOverlap(startMs, endMs, blockStart, blockEnd)) return true;
  }

  return false;
}
