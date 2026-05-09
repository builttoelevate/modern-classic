// Phase 8 — waitlist bookkeeping in Upstash Redis.
//
// Customers submit /api/waitlist when no calendar slot works. The endpoint
// emails the shop (existing behavior) AND now also persists the entry in
// KV so the admin /admin/waitlist page can list, status-track, and act on
// them without depending on the shop's email inbox as the system of record.
//
// Status lifecycle:
//   new       — submitted by customer, not yet seen by shop
//   contacted — shop reached out (call / text / email)
//   booked    — shop scheduled them an appointment
//   archived  — no action needed, hide from default view
//
// Entries TTL at 6 months. Plenty of time for shop to action; keeps KV
// bounded if traffic grows.

import { Redis } from '@upstash/redis';

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
      'Upstash Redis is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel injects these when an Upstash KV store is connected).',
    );
  }
  _redis = new Redis({ url: String(url), token: String(token) });
  return _redis;
}

export type WaitlistStatus = 'new' | 'contacted' | 'booked' | 'archived';

export interface WaitlistEntry {
  id: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  barberName: string;
  /** Square IDs if we resolved them at submit time — used for the
   * "Schedule" deep-link from admin. May be null on older entries. */
  serviceVariationId: string | null;
  /** Legacy single-barber pick. Newer entries also populate
   * teamMemberIds; the cron prefers the array but falls back to
   * [teamMemberId] when teamMemberIds is absent. */
  teamMemberId: string | null;
  /** Customer-selected barbers (multi-pick). Empty / absent =
   * "any barber". Parallel-indexed with barberDisplayNames so the
   * email + admin can name the specific barber a slot opened with. */
  teamMemberIds?: string[];
  /** Display names parallel to teamMemberIds. */
  barberDisplayNames?: string[];
  preferredDate?: string;
  note?: string;
  submittedAt: string;
  status: WaitlistStatus;
  /** Free-text the admin types when marking contacted/booked. */
  adminNote?: string;
  /** ISO of the last status change. */
  statusChangedAt?: string;

  /** Phase 8 — auto-notify preferences. All optional so legacy entries
   * created before this feature still render in admin without breaking. */

  /** ISO date (YYYY-MM-DD) in shop tz, inclusive. Earliest day the
   * customer would accept a slot on. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) in shop tz, inclusive. Latest day. The cron
   * auto-archives entries whose dateTo is in the past. */
  dateTo?: string;
  /** Subset of ['mon','tue','wed','thu','fri','sat']. Empty/absent = any
   * day-of-week is acceptable. Sundays excluded — shop is closed. */
  daysOfWeek?: string[];
  /** Subset of ['morning','afternoon','evening']. Bands: morning < 12,
   * afternoon 12–15, evening ≥ 15 (matches WaitlistSheet TIME_OPTIONS
   * sub-labels and waitlistMatch.bandFor). Empty/absent = any time. */
  timesOfDay?: string[];

  /** Notify bookkeeping — set by the cron once we email the customer
   * about an opening. lastNotifiedAt powers the 12-hour cooldown,
   * notifiedSlotStartAtUtc is the per-slot dedup key. */
  lastNotifiedAt?: string;
  notifiedSlotStartAtUtc?: string;
}

const KEY_PREFIX = 'mc:waitlist:';
const TTL_SECONDS = 60 * 60 * 24 * 180; // 6 months

function kEntry(id: string): string {
  return `${KEY_PREFIX}entry:${id}`;
}
function kIndex(): string {
  return `${KEY_PREFIX}index`;
}

function newId(): string {
  // Short, sortable, no PII. Timestamp + 5 random base36 chars is plenty
  // for the volumes a single-shop waitlist will ever see.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}-${rand}`;
}

export interface RecordWaitlistInput {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  barberName: string;
  serviceVariationId: string | null;
  teamMemberId: string | null;
  /** Multi-pick variants. Parallel arrays. Empty/absent = any barber. */
  teamMemberIds?: string[];
  barberDisplayNames?: string[];
  preferredDate?: string;
  note?: string;
  /** Phase 8 — structured availability prefs for the auto-notify cron. */
  dateFrom?: string;
  dateTo?: string;
  daysOfWeek?: string[];
  timesOfDay?: string[];
}

export async function recordWaitlistEntry(
  input: RecordWaitlistInput,
): Promise<WaitlistEntry> {
  const redis = getRedis();
  const submittedAt = new Date().toISOString();
  const entry: WaitlistEntry = {
    id: newId(),
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    serviceName: input.serviceName,
    barberName: input.barberName,
    serviceVariationId: input.serviceVariationId,
    teamMemberId: input.teamMemberId,
    teamMemberIds: input.teamMemberIds,
    barberDisplayNames: input.barberDisplayNames,
    preferredDate: input.preferredDate,
    note: input.note,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    daysOfWeek: input.daysOfWeek,
    timesOfDay: input.timesOfDay,
    submittedAt,
    status: 'new',
    statusChangedAt: submittedAt,
  };
  await Promise.all([
    redis.set(kEntry(entry.id), entry, { ex: TTL_SECONDS }),
    redis.zadd(kIndex(), { score: Date.now(), member: entry.id }),
  ]);
  return entry;
}

export async function listWaitlistEntries(opts: {
  limit?: number;
  includeArchived?: boolean;
} = {}): Promise<WaitlistEntry[]> {
  const redis = getRedis();
  const limit = opts.limit ?? 100;
  // ZRANGE with REV pulls newest first.
  const ids = await redis.zrange<string[]>(kIndex(), 0, limit - 1, { rev: true });
  if (!ids || ids.length === 0) return [];
  const entries = await Promise.all(
    ids.map((id) => redis.get<WaitlistEntry>(kEntry(id))),
  );
  const out: WaitlistEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (!opts.includeArchived && e.status === 'archived') continue;
    out.push(e);
  }
  return out;
}

export async function getWaitlistEntry(id: string): Promise<WaitlistEntry | null> {
  const redis = getRedis();
  const e = await redis.get<WaitlistEntry>(kEntry(id));
  return e ?? null;
}

export interface UpdateStatusInput {
  id: string;
  status: WaitlistStatus;
  adminNote?: string;
}

export async function updateWaitlistStatus(
  input: UpdateStatusInput,
): Promise<WaitlistEntry | null> {
  const redis = getRedis();
  const existing = await redis.get<WaitlistEntry>(kEntry(input.id));
  if (!existing) return null;
  const updated: WaitlistEntry = {
    ...existing,
    status: input.status,
    adminNote: input.adminNote ?? existing.adminNote,
    statusChangedAt: new Date().toISOString(),
  };
  await redis.set(kEntry(input.id), updated, { keepTtl: true });
  return updated;
}

export async function countWaitlistByStatus(): Promise<Record<WaitlistStatus, number>> {
  const all = await listWaitlistEntries({ limit: 500, includeArchived: true });
  const counts: Record<WaitlistStatus, number> = {
    new: 0,
    contacted: 0,
    booked: 0,
    archived: 0,
  };
  for (const e of all) counts[e.status]++;
  return counts;
}

/**
 * Phase 8 — list only waitlist entries the auto-notify cron should
 * still consider. 'booked' and 'archived' are out by definition.
 */
export async function listActiveWaitlistEntries(opts: { limit?: number } = {}): Promise<
  WaitlistEntry[]
> {
  const all = await listWaitlistEntries({
    limit: opts.limit ?? 500,
    includeArchived: false,
  });
  return all.filter((e) => e.status === 'new' || e.status === 'contacted');
}

/**
 * Phase 8 — record that we just emailed a customer about a specific
 * slot opening. Sets both lastNotifiedAt (powers the 12-hour cooldown)
 * and notifiedSlotStartAtUtc (per-slot dedup). Preserves the entry's
 * existing TTL via keepTtl, mirroring recordReviewRequestClicked.
 */
export async function markWaitlistNotified(
  id: string,
  slotStartAtUtc: string,
): Promise<WaitlistEntry | null> {
  const redis = getRedis();
  const existing = await redis.get<WaitlistEntry>(kEntry(id));
  if (!existing) return null;
  const updated: WaitlistEntry = {
    ...existing,
    lastNotifiedAt: new Date().toISOString(),
    notifiedSlotStartAtUtc: slotStartAtUtc,
  };
  await redis.set(kEntry(id), updated, { keepTtl: true });
  return updated;
}

/**
 * Resolve an entry's barber picks as a list of (id, displayName) pairs.
 * Returns [] when the customer chose "any barber". Falls back to the
 * legacy single teamMemberId/barberName pair for entries created before
 * multi-pick was supported.
 */
export function getEntryBarberPicks(entry: WaitlistEntry): Array<{ id: string; displayName: string }> {
  if (entry.teamMemberIds && entry.teamMemberIds.length > 0) {
    return entry.teamMemberIds.map((id, i) => ({
      id,
      displayName: entry.barberDisplayNames?.[i] ?? entry.barberName,
    }));
  }
  if (entry.teamMemberId) {
    return [{ id: entry.teamMemberId, displayName: entry.barberName }];
  }
  return [];
}
