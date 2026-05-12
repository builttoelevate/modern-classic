// Own-list block-from-booking enforcement.
//
// Square's per-customer "Block from booking" toggle in the dashboard
// is enforced only on Square's own hosted booking page; the flag
// isn't exposed on the Customer object returned by the public API.
// When Modern Classic moved to a custom Bookings API integration,
// every blocked customer silently started slipping through.
// Michael's report (2026-05-12): "I think it's letting our blocked
// customers book."
//
// Rather than couple block enforcement to Square (via Customer
// Groups, which would still cost a Square round trip per booking
// attempt and wouldn't travel if the shop ever switched booking
// systems), we maintain our own list — keyed by normalized
// E.164 phone — in Upstash Redis. The booking endpoint checks
// before calling Square's CreateBooking; admin endpoints under
// /api/admin/blocks let Bill / Michael manage the list.
//
// Migration is manual: Michael walks the Square "Block from
// booking" list once and adds each phone via the admin endpoint.
// One-time pain; the list is small.
//
// Schema:
//   mc:block:phones                 — Redis SET of every blocked E.164.
//   mc:block:phone:<E164>           — JSON {reason?, blockedAt, blockedBy?}.
//
// The SET is the source of truth for "is this phone blocked?"
// (SISMEMBER is O(1)); the per-phone string holds metadata. We never
// rely on KEYS / SCAN — the SET stays authoritative even if the
// metadata key is ever lost.

import { Redis } from '@upstash/redis';
import { normalizePhone } from '../phone';

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

const KEY_PREFIX = 'mc:block:';
const KEY_SET = `${KEY_PREFIX}phones`;
function kPhone(e164: string): string {
  return `${KEY_PREFIX}phone:${e164}`;
}

export interface BlockedEntry {
  /** Phone in E.164 form, e.g. "+17402974462". */
  phone: string;
  /** Optional free-text reason. Visible only to admins; never surfaced
   *  to the blocked customer. */
  reason?: string;
  /** ISO timestamp the block was added. */
  blockedAt: string;
  /** Optional identifier of who added the block (e.g. "michael").
   *  Free text, no enforcement. */
  blockedBy?: string;
}

interface StoredEntry {
  reason?: string;
  blockedAt: string;
  blockedBy?: string;
}

/**
 * Fast yes/no check for the booking hot path. Returns false on any
 * KV failure (fail-open with a noisy log) — we'd rather let a single
 * booking through than nuke the entire booking flow on a transient
 * Redis blip. The booking is logged either way, so a missed block is
 * recoverable; a 503 storm is not.
 */
export async function isPhoneBlocked(phone: string): Promise<boolean> {
  const e164 = normalizePhone(phone);
  if (!e164) return false;
  try {
    const member = await getRedis().sismember(KEY_SET, e164);
    return member === 1;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(
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

export async function listBlockedPhones(): Promise<BlockedEntry[]> {
  const redis = getRedis();
  const members = (await redis.smembers(KEY_SET)) as string[];
  if (members.length === 0) return [];
  // Fetch metadata in parallel. mget would also work; this stays
  // explicit so a missing metadata key surfaces as `null` and we can
  // still list the phone with synthesized fields.
  const entries = await Promise.all(
    members.map(async (phone) => {
      const raw = await redis.get<StoredEntry | string | null>(kPhone(phone));
      const parsed: StoredEntry | null =
        raw == null
          ? null
          : typeof raw === 'string'
            ? safeParse(raw)
            : (raw as StoredEntry);
      return {
        phone,
        reason: parsed?.reason,
        blockedAt: parsed?.blockedAt ?? new Date(0).toISOString(),
        blockedBy: parsed?.blockedBy,
      } satisfies BlockedEntry;
    }),
  );
  entries.sort((a, b) => (a.blockedAt < b.blockedAt ? 1 : -1));
  return entries;
}

export interface AddResult {
  /** True when the phone was newly added; false when it was already blocked. */
  added: boolean;
  /** The stored entry — the existing one when already blocked (untouched),
   *  the new one when added. */
  entry: BlockedEntry;
}

/** Adds a phone to the block list. Idempotent: re-adding a phone that's
 *  already blocked is a no-op (existing metadata is preserved — the
 *  original blockedAt timestamp wins so the audit trail is intact). The
 *  caller can distinguish via the `added` flag. */
export async function addBlockedPhone(
  phone: string,
  opts: { reason?: string; blockedBy?: string } = {},
): Promise<AddResult> {
  const e164 = normalizePhone(phone);
  if (!e164 || !/^\+\d{10,15}$/.test(e164)) {
    throw new Error(`Phone "${phone}" is not a valid E.164 number after normalization.`);
  }
  const redis = getRedis();
  const added = await redis.sadd(KEY_SET, e164);
  if (added === 0) {
    // Already a member — return the existing metadata without touching
    // the stored entry. Preserves blockedAt + original reason.
    const raw = await redis.get<StoredEntry | string | null>(kPhone(e164));
    const parsed: StoredEntry | null =
      raw == null
        ? null
        : typeof raw === 'string'
          ? safeParse(raw)
          : (raw as StoredEntry);
    return {
      added: false,
      entry: {
        phone: e164,
        reason: parsed?.reason,
        blockedAt: parsed?.blockedAt ?? new Date(0).toISOString(),
        blockedBy: parsed?.blockedBy,
      },
    };
  }
  const entry: StoredEntry = {
    blockedAt: new Date().toISOString(),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.blockedBy ? { blockedBy: opts.blockedBy } : {}),
  };
  await redis.set(kPhone(e164), JSON.stringify(entry));
  return { added: true, entry: { phone: e164, ...entry } };
}

/** Removes a phone from the block list. Returns true if the phone was
 *  in the list, false if it wasn't. Idempotent. */
export async function removeBlockedPhone(phone: string): Promise<boolean> {
  const e164 = normalizePhone(phone);
  if (!e164) return false;
  const redis = getRedis();
  const [removed] = await Promise.all([redis.srem(KEY_SET, e164), redis.del(kPhone(e164))]);
  return removed === 1;
}

function safeParse(s: string): StoredEntry | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && 'blockedAt' in v) return v as StoredEntry;
    return null;
  } catch {
    return null;
  }
}
