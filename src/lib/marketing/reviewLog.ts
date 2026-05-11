// Phase 7 — review-request bookkeeping in Upstash Redis.
//
// We need three things tracked across cron invocations:
//   1) "Have we already emailed this booking?" — duplicate-detection so a
//      double cron run never double-sends.
//   2) "When did this customer last get one?" — per-customer cooldown
//      (REVIEW_REQUEST_COOLDOWN_DAYS in the cron) so regulars who book
//      every two weeks don't get a steady drip of review pleas.
//      Mirrors the Square Custom Attribute (last_review_request_sent_at)
//      so we have belt-and-suspenders if KV is briefly unreachable.
//   3) "Was the CTA clicked?" — for the /admin/reviews stats page.
//
// Upstash's native @upstash/redis is preferred over @vercel/kv: it reads
// the same KV_REST_API_URL / KV_REST_API_TOKEN env vars that Vercel
// injects automatically when you connect Upstash, and it's the SDK
// Upstash itself ships.

import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;
  if (typeof window !== 'undefined') {
    throw new Error('Upstash Redis is server-only.');
  }
  // Redis.fromEnv() reads UPSTASH_REDIS_REST_URL/_TOKEN. Vercel's Upstash
  // integration injects the same values under KV_REST_API_URL/TOKEN, so
  // we map manually rather than assuming either pair exists.
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

const KEY_PREFIX = 'mc:review:';
function kSent(reviewRequestId: string): string {
  return `${KEY_PREFIX}sent:${reviewRequestId}`;
}
function kByBooking(bookingId: string): string {
  return `${KEY_PREFIX}by-booking:${bookingId}`;
}
function kByCustomerLatest(customerId: string): string {
  return `${KEY_PREFIX}by-customer:${customerId}:latest`;
}
function kIndex(): string {
  return `${KEY_PREFIX}index`;
}
function kLastRun(): string {
  return `${KEY_PREFIX}last-run`;
}

export interface LastCronRunSummary {
  ranAt: string;
  manuallyTriggered: boolean;
  dryRun: boolean;
  windowStartUtc: string;
  windowEndUtc: string;
  processed: number;
  sent: number;
  skipped: {
    notAccepted: number;
    alreadySent: number;
    customerMissing: number;
    optedOut: number;
    recentRequest: number;
    serviceMissing: number;
    barberMissing: number;
  };
  failures: number;
  /** Set when the cron returned a top-level error (auth, env, Square
   *  list failure). Successful runs leave this undefined. */
  error?: { code: string; detail: string };
}

/** Records the most recent cron-run summary so /admin/reviews can
 *  show Michael "the cron ran at X, processed N bookings, skipped
 *  reason breakdown." No TTL — there's only ever one record under
 *  this key. */
export async function recordReviewCronRun(summary: LastCronRunSummary): Promise<void> {
  const redis = getRedis();
  await redis.set(kLastRun(), summary);
}

export async function getLastReviewCronRun(): Promise<LastCronRunSummary | null> {
  const redis = getRedis();
  const r = await redis.get<LastCronRunSummary>(kLastRun());
  return r ?? null;
}

export interface ReviewRequestRecord {
  reviewRequestId: string;
  customerId: string;
  bookingId: string;
  customerEmailRedacted: string;
  /** Customer display name at send time, used by the click handler to
   *  populate the barber notification email. Optional for back-compat
   *  with older records written before this field was added. */
  customerName?: string;
  serviceName: string;
  barberName: string;
  /** Square team_member_id of the barber the review request is for.
   *  Optional for back-compat with older records; the click handler
   *  skips the barber-notify path when it's missing. */
  teamMemberId?: string;
  /** Pre-formatted appointment date string for the click email
   *  (e.g. "Fri, Jun 26, 2026"). Optional for back-compat. */
  appointmentDate?: string;
  sentAt: string;
  clickedAt: string | null;
  clickCount: number;
  resendId?: string;
}

export interface RecordSentInput {
  reviewRequestId: string;
  customerId: string;
  bookingId: string;
  customerEmailRedacted: string;
  customerName?: string;
  serviceName: string;
  barberName: string;
  teamMemberId?: string;
  appointmentDate?: string;
  sentAt: string;
  resendId?: string;
}

export async function recordReviewRequestSent(input: RecordSentInput): Promise<void> {
  const redis = getRedis();
  const record: ReviewRequestRecord = {
    reviewRequestId: input.reviewRequestId,
    customerId: input.customerId,
    bookingId: input.bookingId,
    customerEmailRedacted: input.customerEmailRedacted,
    ...(input.customerName ? { customerName: input.customerName } : {}),
    serviceName: input.serviceName,
    barberName: input.barberName,
    ...(input.teamMemberId ? { teamMemberId: input.teamMemberId } : {}),
    ...(input.appointmentDate ? { appointmentDate: input.appointmentDate } : {}),
    sentAt: input.sentAt,
    clickedAt: null,
    clickCount: 0,
    resendId: input.resendId,
  };
  // 13-month TTL — long enough for stats, short enough to keep the store
  // bounded. Adjust if Phase 10 reporting needs a longer window.
  const ttl = 60 * 60 * 24 * 400;
  await Promise.all([
    redis.set(kSent(input.reviewRequestId), record, { ex: ttl }),
    redis.set(kByBooking(input.bookingId), input.reviewRequestId, { ex: ttl }),
    redis.set(kByCustomerLatest(input.customerId), input.sentAt, { ex: ttl }),
    // Sorted index by sent timestamp (numeric score = ms since epoch) for
    // the admin dashboard's "recent" listing.
    redis.zadd(kIndex(), { score: new Date(input.sentAt).getTime(), member: input.reviewRequestId }),
  ]);
}

export async function hasReviewRequestBeenSent(bookingId: string): Promise<boolean> {
  const redis = getRedis();
  const id = await redis.get(kByBooking(bookingId));
  return typeof id === 'string' && id.length > 0;
}

export async function getLastReviewRequestForCustomer(
  customerId: string,
): Promise<string | null> {
  const redis = getRedis();
  const ts = await redis.get<string>(kByCustomerLatest(customerId));
  return typeof ts === 'string' && ts.length > 0 ? ts : null;
}

/**
 * Records a click on a review request CTA. Returns the previous
 * `clickedAt` value (or null) along with the up-to-date record — the
 * caller uses the null-previous case to fire a one-time "customer is
 * leaving a review" notification to the barber on the first click, and
 * skip subsequent clicks so the barber doesn't get re-pinged each time
 * the customer revisits the link.
 */
export async function recordReviewRequestClicked(
  reviewRequestId: string,
): Promise<{ record: ReviewRequestRecord; wasFirstClick: boolean } | null> {
  const redis = getRedis();
  const key = kSent(reviewRequestId);
  const current = await redis.get<ReviewRequestRecord>(key);
  if (!current) {
    // Token was valid (HMAC verified) but no record exists — could happen
    // if the entry expired. Log a stub for visibility.
    // eslint-disable-next-line no-console
    console.log(
      `[REVIEW] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'click-without-record',
        reviewRequestId,
      })}`,
    );
    return null;
  }
  const wasFirstClick = current.clickedAt === null;
  const updated: ReviewRequestRecord = {
    ...current,
    clickedAt: current.clickedAt ?? new Date().toISOString(),
    clickCount: (current.clickCount ?? 0) + 1,
  };
  await redis.set(key, updated, { keepTtl: true });
  return { record: updated, wasFirstClick };
}

export async function getReviewStats(opts: {
  daysBack: number;
  recentLimit?: number;
}): Promise<{
  daysBack: number;
  sent: number;
  clicked: number;
  clickRate: number;
  recent: ReviewRequestRecord[];
}> {
  const redis = getRedis();
  const cutoff = Date.now() - opts.daysBack * 24 * 60 * 60 * 1000;

  // ZRANGEBYSCORE — pull review IDs sent within the window, newest first.
  const ids = (await redis.zrange(kIndex(), cutoff, '+inf', { byScore: true })) as string[];

  if (ids.length === 0) {
    return { daysBack: opts.daysBack, sent: 0, clicked: 0, clickRate: 0, recent: [] };
  }

  // mget the records for these ids.
  const keys = ids.map(kSent);
  const records = (await redis.mget<ReviewRequestRecord[]>(...keys)) ?? [];
  const valid: ReviewRequestRecord[] = [];
  for (const r of records) {
    if (r && typeof r === 'object' && 'reviewRequestId' in r) {
      valid.push(r);
    }
  }

  // Sort newest first.
  valid.sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));

  const sent = valid.length;
  const clicked = valid.filter((r) => r.clickedAt).length;
  const clickRate = sent === 0 ? 0 : clicked / sent;
  const recent = valid.slice(0, opts.recentLimit ?? 50);
  return { daysBack: opts.daysBack, sent, clicked, clickRate, recent };
}

/**
 * Test-cleanup helper. Removes a single review request record + its
 * indexes. Not exposed via any HTTP endpoint — call from a script if
 * needed during testing.
 */
export async function deleteReviewRequest(input: {
  reviewRequestId: string;
  bookingId: string;
  customerId: string;
}): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.del(kSent(input.reviewRequestId)),
    redis.del(kByBooking(input.bookingId)),
    redis.del(kByCustomerLatest(input.customerId)),
    redis.zrem(kIndex(), input.reviewRequestId),
  ]);
}
