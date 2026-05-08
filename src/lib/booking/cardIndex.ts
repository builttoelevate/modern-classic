// Booking → card-on-file index (Upstash Redis).
//
// When a new customer completes the card-capture step, /api/square/bookings
// writes a record here so we can later look up "does this booking have a
// card on file?" without round-tripping every booking through Square's
// Cards API just to check.
//
// Two read paths:
//   - /api/square/bookings/[id]/cancel  — within 24h, decides whether to
//     show the late-cancel charge confirmation modal.
//   - /admin/bookings  — decides whether to render the
//     "Mark no-show & charge" button on the row.
//
// Two write paths:
//   - createBookingCardRecord(): on successful new-customer booking.
//   - markBookingCharged(): once a charge succeeds, so the same booking
//     is never charged twice via different paths.
//
// Keys live under `mc:card-on-file:` to keep them clearly partitioned
// from the existing `mc:review:` namespace in lib/marketing/reviewLog.ts.

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

const KEY_PREFIX = 'mc:card-on-file:';
function kBooking(bookingId: string): string {
  return `${KEY_PREFIX}booking:${bookingId}`;
}

export type ChargeStatus =
  | 'pending'        // card on file, never charged
  | 'late-cancel'    // charged because customer cancelled inside 24h
  | 'no-show'        // charged because Michael marked no-show
  | 'failed';        // last charge attempt failed; safe to retry

export interface BookingCardRecord {
  bookingId: string;
  squareCustomerId: string;
  squareCardId: string;
  /** Final price in cents. For VARIABLE_PRICING services this falls back
   *  to the catalog min price; for FIXED it's the actual variation price.
   *  Used as the charge amount. */
  servicePriceCents: number;
  /** The serviceVariation's display name at booking time, for the audit log. */
  serviceName: string;
  startAtUtc: string;
  chargeStatus: ChargeStatus;
  /** Square payment id once chargeStatus !== 'pending' / 'failed'. */
  chargedPaymentId?: string;
  chargedAt?: string;
  chargeFailureReason?: string;
}

// 90-day MINIMUM TTL — long enough to cover a no-show being noticed
// late plus the 14-day window Square allows for charging a saved card
// after a missed appointment. For bookings further than ~60 days out
// we extend the TTL so the record still exists when the appointment
// happens; otherwise a 4-month-out booking would lose its card record
// before the customer ever shows up (or doesn't).
const MIN_TTL_SECONDS = 60 * 60 * 24 * 90;
const POST_APPOINTMENT_BUFFER_SECONDS = 60 * 60 * 24 * 45;

function computeTtlSeconds(startAtUtc: string): number {
  const startMs = new Date(startAtUtc).getTime();
  if (!Number.isFinite(startMs)) return MIN_TTL_SECONDS;
  const secondsUntilStart = Math.max(0, Math.floor((startMs - Date.now()) / 1000));
  return Math.max(MIN_TTL_SECONDS, secondsUntilStart + POST_APPOINTMENT_BUFFER_SECONDS);
}

export interface CreateInput {
  bookingId: string;
  squareCustomerId: string;
  squareCardId: string;
  servicePriceCents: number;
  serviceName: string;
  startAtUtc: string;
}

export async function createBookingCardRecord(input: CreateInput): Promise<void> {
  const redis = getRedis();
  const record: BookingCardRecord = {
    bookingId: input.bookingId,
    squareCustomerId: input.squareCustomerId,
    squareCardId: input.squareCardId,
    servicePriceCents: input.servicePriceCents,
    serviceName: input.serviceName,
    startAtUtc: input.startAtUtc,
    chargeStatus: 'pending',
  };
  await redis.set(kBooking(input.bookingId), record, {
    ex: computeTtlSeconds(input.startAtUtc),
  });
}

export async function getBookingCardRecord(
  bookingId: string,
): Promise<BookingCardRecord | null> {
  const redis = getRedis();
  const record = await redis.get<BookingCardRecord>(kBooking(bookingId));
  if (!record || typeof record !== 'object') return null;
  return record;
}

export interface MarkChargedInput {
  bookingId: string;
  chargeStatus: 'late-cancel' | 'no-show';
  chargedPaymentId: string;
}

export async function markBookingCharged(input: MarkChargedInput): Promise<void> {
  const redis = getRedis();
  const current = await getBookingCardRecord(input.bookingId);
  if (!current) return; // nothing to mark
  const updated: BookingCardRecord = {
    ...current,
    chargeStatus: input.chargeStatus,
    chargedPaymentId: input.chargedPaymentId,
    chargedAt: new Date().toISOString(),
    chargeFailureReason: undefined,
  };
  await redis.set(kBooking(input.bookingId), updated, {
    ex: computeTtlSeconds(current.startAtUtc),
  });
}

export async function markBookingChargeFailed(
  bookingId: string,
  reason: string,
): Promise<void> {
  const redis = getRedis();
  const current = await getBookingCardRecord(bookingId);
  if (!current) return;
  const updated: BookingCardRecord = {
    ...current,
    chargeStatus: 'failed',
    chargeFailureReason: reason.slice(0, 500),
  };
  await redis.set(kBooking(bookingId), updated, {
    ex: computeTtlSeconds(current.startAtUtc),
  });
}

/**
 * Bulk lookup for the admin list. Returns a Map keyed by bookingId for
 * O(1) checks while rendering the table. Missing bookings are simply
 * absent from the map; callers should treat that as "no card on file".
 *
 * Defensive: every record's own bookingId is checked against the
 * requested key before insertion. Without this guard a partial mget
 * response from Upstash (rare but possible during a node failover)
 * could shift the array and silently map booking[i] → record belonging
 * to booking[j], showing the wrong card / charge amount in admin or
 * /my-bookings.
 */
export async function getBookingCardRecords(
  bookingIds: string[],
): Promise<Map<string, BookingCardRecord>> {
  const out = new Map<string, BookingCardRecord>();
  if (bookingIds.length === 0) return out;
  const redis = getRedis();
  const keys = bookingIds.map(kBooking);
  const records = (await redis.mget<BookingCardRecord[]>(...keys)) ?? [];
  for (let i = 0; i < bookingIds.length; i++) {
    const r = records[i];
    if (!r || typeof r !== 'object' || !('bookingId' in r)) continue;
    if (r.bookingId !== bookingIds[i]) {
      // Length / order mismatch — never trust a record whose own id
      // doesn't match the slot we expected. Skipping is safer than
      // attaching the wrong card to the wrong booking.
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'card-index-mget-mismatch',
          expected: bookingIds[i],
          got: r.bookingId,
        })}`,
      );
      continue;
    }
    out.set(bookingIds[i], r);
  }
  return out;
}
