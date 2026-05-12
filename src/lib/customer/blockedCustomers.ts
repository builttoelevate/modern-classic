// Own-list block-from-booking enforcement for Modern Classic's site.
//
// Square's per-customer "Block from booking" toggle in the Dashboard
// is enforced only on Square's own hosted booking page — the flag is
// not exposed on the public API. The custom Bookings API integration
// has no idea who Michael has tried to block via that toggle, so we
// maintain our own list, keyed by normalized E.164 phone, in Upstash
// Redis.
//
// Scope: this list applies to PUBLIC online booking ONLY (single,
// group, reschedule, quick-rebook). Admin-created and barber-created
// bookings get a different override pattern (PR 3). The split is
// intentional — the shop should always retain the ability to book
// someone in at the chair, even if they're on the online block list.
//
// Schema:
//   mc:block:phones                 SET<E.164>   — O(1) membership for the hot-path check.
//   mc:block:phone:<E.164>          JSON entry   — metadata + canonical record.
//   mc:block:by-id:<UUID>           string<E.164> — id → phone reverse index for DELETE-by-id.
//   mc:block:attempts               STREAM       — append-only XADD per blocked attempt (PR 3 viewer).

import { Redis } from '@upstash/redis';
import { normalizePhone } from '../phone';
import { REDIS_KEY_PREFIX, SHOP_PHONE } from '../branding';

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

const NS = `${REDIS_KEY_PREFIX}:block`;
const KEY_SET = `${NS}:phones`;
const KEY_ATTEMPTS_STREAM = `${NS}:attempts`;
const ATTEMPTS_STREAM_MAXLEN = 10_000;

function kPhone(e164: string): string {
  return `${NS}:phone:${e164}`;
}
function kById(id: string): string {
  return `${NS}:by-id:${id}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface BlockedEntry {
  /** Stable UUID. Generated on add; carried for the life of the block.
   *  Admin DELETE keys off this, not the phone. */
  id: string;
  /** E.164, the canonical form. */
  phone: string;
  /** Whatever the operator originally typed, for display. */
  phoneOriginal: string;
  /** Internal-only — never surfaced to the customer. */
  reason?: string;
  blockedAt: string;
  blockedBy?: string;
  /** Equals blockedAt in v1 (no edits). Reserved for a future PATCH route. */
  updatedAt: string;
}

export type BookingContext = 'single' | 'group' | 'reschedule' | 'quick-rebook';

export interface BlockAttemptContext {
  bookingContext: BookingContext;
  phoneOriginal?: string;
  customerName?: string;
  customerEmail?: string;
  serviceId?: string;
  barberId?: string;
  selectedStartAt?: string;
  ipAddress?: string;
  userAgent?: string;
}

export class CustomerBlockedError extends Error {
  readonly entry: BlockedEntry;
  constructor(entry: BlockedEntry) {
    super(`Phone ${entry.phone} is on the block list (id=${entry.id}).`);
    this.name = 'CustomerBlockedError';
    this.entry = entry;
  }
}

export interface AddResult {
  status: 'created' | 'already_blocked';
  block: BlockedEntry;
}

// ─────────────────────────────────────────────────────────────────────────
// Hot-path check + booking guard
// ─────────────────────────────────────────────────────────────────────────

/** Fast yes/no for the booking hot path. Returns false (fail-open) on
 *  any KV failure. A missed block is recoverable (shop declines at the
 *  chair); a 503 storm on every booking attempt because Redis blipped
 *  is not. */
export async function isPhoneBlocked(phone: string): Promise<boolean> {
  const e164 = normalizePhone(phone);
  if (!e164) return false;
  try {
    const member = await getRedis().sismember(KEY_SET, e164);
    return member === 1;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[BLOCK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'block-check-failed',
        e164,
        detail,
      })}`,
    );
    return false;
  }
}

/**
 * Guard called immediately before each public CreateBooking. On hit,
 * fires-and-(best-effort-)logs to the attempts stream BEFORE throwing.
 * Stream-log failure does NOT block enforcement — enforcement > logging.
 *
 * Uses normalizePhone from src/lib/phone.ts; do not reimplement.
 */
export async function assertPhoneNotBlocked(
  phone: string,
  ctx: BlockAttemptContext,
): Promise<void> {
  const e164 = normalizePhone(phone);
  if (!e164) return;
  const entry = await fetchEntryByPhone(e164);
  if (!entry) return;
  // Best-effort attempts-log write. Failures are logged to stderr and
  // swallowed so the throw still happens.
  try {
    await logBlockedAttempt(entry, ctx);
  } catch (logErr) {
    const detail = logErr instanceof Error ? logErr.message : String(logErr);
    console.error(
      `[BLOCK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'stream-log-failed',
        e164,
        bookingContext: ctx.bookingContext,
        detail,
      })}`,
    );
  }
  throw new CustomerBlockedError(entry);
}

async function logBlockedAttempt(entry: BlockedEntry, ctx: BlockAttemptContext): Promise<void> {
  const fields: Record<string, string> = {
    phone: entry.phone,
    phoneOriginal: ctx.phoneOriginal ?? entry.phoneOriginal,
    bookingContext: ctx.bookingContext,
    attemptedAt: new Date().toISOString(),
  };
  if (ctx.customerName) fields.customerName = ctx.customerName;
  if (ctx.customerEmail) fields.customerEmail = ctx.customerEmail;
  if (ctx.serviceId) fields.serviceId = ctx.serviceId;
  if (ctx.barberId) fields.barberId = ctx.barberId;
  if (ctx.selectedStartAt) fields.selectedStartAt = ctx.selectedStartAt;
  if (ctx.ipAddress) fields.ipAddress = ctx.ipAddress;
  if (ctx.userAgent) fields.userAgent = ctx.userAgent.slice(0, 500);
  await getRedis().xadd(KEY_ATTEMPTS_STREAM, '*', fields, {
    trim: { type: 'MAXLEN', threshold: ATTEMPTS_STREAM_MAXLEN, comparison: '~' },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Centralized public refusal — the ONE place that owns the 403 shape
// ─────────────────────────────────────────────────────────────────────────

/**
 * The ONLY way to construct a public refusal response for a blocked
 * customer. Centralized so we can't drift the shape, error code, or
 * message text across the 4 guarded booking paths. Audit by grep:
 * `BOOKING_UNAVAILABLE_ONLINE` should appear in exactly this one file.
 *
 * Does NOT include the word "block"/"blocked"/"banned" or the `reason`
 * field text. The customer is funneled to a human at the shop.
 */
export function blockedBookingPublicResponse(): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: 'BOOKING_UNAVAILABLE_ONLINE',
        detail: `We weren't able to complete this booking online. Please contact the shop at ${SHOP_PHONE} to schedule.`,
      },
    },
    { status: 403 },
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Admin operations
// ─────────────────────────────────────────────────────────────────────────

export async function listBlockedEntries(): Promise<BlockedEntry[]> {
  const redis = getRedis();
  const members = (await redis.smembers(KEY_SET)) as string[];
  if (members.length === 0) return [];
  const entries = await Promise.all(members.map((phone) => fetchEntryByPhone(phone)));
  const filtered = entries.filter((e): e is BlockedEntry => e !== null);
  filtered.sort((a, b) => (a.blockedAt < b.blockedAt ? 1 : -1));
  return filtered;
}

/**
 * Idempotent add. Two concurrent POSTs for the same phone both invoke
 * SADD; exactly one wins, the loser gets `already_blocked` with the
 * winner's existing metadata. The metadata SET is gated on the SADD
 * win so the loser cannot overwrite blockedAt / reason.
 */
export async function addBlockedPhone(
  phoneInput: string,
  opts: { reason?: string; blockedBy?: string } = {},
): Promise<AddResult> {
  const e164 = normalizePhone(phoneInput);
  if (!e164 || !/^\+\d{10,15}$/.test(e164)) {
    throw new Error(`Phone "${phoneInput}" is not a valid E.164 number after normalization.`);
  }
  const redis = getRedis();
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const entry: BlockedEntry = {
    id,
    phone: e164,
    phoneOriginal: phoneInput,
    blockedAt: nowIso,
    updatedAt: nowIso,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.blockedBy ? { blockedBy: opts.blockedBy } : {}),
  };
  const added = await redis.sadd(KEY_SET, e164);
  if (added === 1) {
    await Promise.all([
      redis.set(kPhone(e164), JSON.stringify(entry)),
      redis.set(kById(id), e164),
    ]);
    return { status: 'created', block: entry };
  }
  // Already in the SET. Return the existing entry untouched — preserves
  // original blockedAt / reason. If the metadata key is missing (very
  // narrow race window where the winner SADD'd but hasn't SET yet),
  // synthesize from the current payload but DO NOT write — the winner
  // will land their own SET shortly.
  const existing = await fetchEntryByPhone(e164);
  return { status: 'already_blocked', block: existing ?? entry };
}

/** Remove by stable UUID. Used by the admin DELETE endpoint. Returns
 *  the removed entry or null if id didn't resolve. Idempotent. */
export async function removeBlockedById(id: string): Promise<BlockedEntry | null> {
  if (!id) return null;
  const redis = getRedis();
  const e164 = (await redis.get<string | null>(kById(id))) ?? null;
  if (!e164) return null;
  const entry = await fetchEntryByPhone(e164);
  await Promise.all([
    redis.srem(KEY_SET, e164),
    redis.del(kPhone(e164)),
    redis.del(kById(id)),
  ]);
  return entry;
}

/** Internal: remove by phone. Kept for completeness; admin API uses
 *  removeBlockedById. */
export async function removeBlockedPhone(phoneInput: string): Promise<BlockedEntry | null> {
  const e164 = normalizePhone(phoneInput);
  if (!e164) return null;
  const entry = await fetchEntryByPhone(e164);
  const redis = getRedis();
  await Promise.all([
    redis.srem(KEY_SET, e164),
    redis.del(kPhone(e164)),
    ...(entry?.id ? [redis.del(kById(entry.id))] : []),
  ]);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

async function fetchEntryByPhone(e164: string): Promise<BlockedEntry | null> {
  const raw = await getRedis().get<BlockedEntry | string | null>(kPhone(e164));
  if (raw == null) return null;
  if (typeof raw === 'string') return parseEntry(raw, e164);
  // Upstash auto-deserializes JSON-string values on read. Trust the
  // shape but defensively normalize missing fields for backwards
  // compat with rows written by PR 1 (which lacked id / phoneOriginal /
  // updatedAt). PR 1's prod data is empty, but this keeps a dev
  // database mid-migration from blowing up.
  return ensureShape(raw, e164);
}

function parseEntry(raw: string, e164: string): BlockedEntry | null {
  try {
    return ensureShape(JSON.parse(raw) as Partial<BlockedEntry>, e164);
  } catch {
    return null;
  }
}

function ensureShape(v: Partial<BlockedEntry>, e164: string): BlockedEntry {
  return {
    id: v.id ?? '',
    phone: v.phone ?? e164,
    phoneOriginal: v.phoneOriginal ?? v.phone ?? e164,
    reason: v.reason,
    blockedAt: v.blockedAt ?? new Date(0).toISOString(),
    blockedBy: v.blockedBy,
    updatedAt: v.updatedAt ?? v.blockedAt ?? new Date(0).toISOString(),
  };
}
