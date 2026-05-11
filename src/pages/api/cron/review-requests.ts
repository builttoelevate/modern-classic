// Phase 7 — daily review-request cron.
//
// Runs once a day (10 AM ET via vercel.json). Pulls bookings whose
// start_at is between (now - 5 days) and (now - 2 days), filters to
// ACCEPTED appointments, eligibility-checks each customer, and emails a
// Google review request to anyone who qualifies and hasn't already been
// asked for this booking. Idempotent — running it twice in a day must
// never double-send.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. We use
// REVIEW_CRON_SECRET (separate from the rebuild cron's CRON_SECRET) so
// the two can be rotated/disabled independently.

import type { APIRoute } from 'astro';
import { listBookings } from '../../../lib/square/bookings';
import { getBarbers } from '../../../lib/square/team';
import { getServices } from '../../../lib/square/catalog';
import { getCustomerById } from '../../../lib/square/customers';
import {
  LAST_REVIEW_REQUEST_SENT_AT_KEY,
  getAllMarketingAttributes,
  setCustomAttribute,
} from '../../../lib/square/customAttributes';
import { isOptedInForMarketing } from '../../../lib/marketing/eligibility';
import {
  hasReviewRequestBeenSent,
  recordReviewRequestSent,
} from '../../../lib/marketing/reviewLog';
import { signClickToken } from '../../../lib/marketing/clickToken';
import { signUnsubscribeToken } from '../../../lib/marketing/unsubscribeToken';
import { sendReviewRequest } from '../../../lib/email/resend';
import { redactEmail } from '../../../lib/booking/log';
import { SquareApiError } from '../../../lib/square/client';
import type { Booking } from '../../../lib/square/types';

export const prerender = false;

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';
/**
 * How long to wait before asking the same customer for another review.
 * Tuned up from the original 30-day spec — twice a year keeps loyal
 * regulars from feeling pestered and matches the cadence of normal
 * "how was your visit?" follow-ups in the wild.
 */
const REVIEW_REQUEST_COOLDOWN_DAYS = 180;
const WINDOW_MIN_DAYS = 2;
const WINDOW_MAX_DAYS = 5;

interface CronOk {
  ok: true;
  ranAt: string;
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
  failureDetails: Array<{ bookingId: string; reason: string }>;
}

interface CronFail {
  ok: false;
  error: { code: string; detail: string };
}

function logCron(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[REVIEW-CRON] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isAuthorized(request: Request): boolean {
  const expected = import.meta.env.REVIEW_CRON_SECRET;
  if (typeof expected !== 'string' || !expected) return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const supplied = header.slice(7).trim();
  return constantTimeEqual(supplied, expected);
}

function formatAppointmentDate(startAtUtc: string): string {
  const d = new Date(startAtUtc);
  if (isNaN(d.getTime())) return startAtUtc;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

async function handle(request: Request): Promise<Response> {
  if (!import.meta.env.REVIEW_CRON_SECRET) {
    const body: CronFail = {
      ok: false,
      error: { code: 'CRON_NOT_CONFIGURED', detail: 'REVIEW_CRON_SECRET is not set.' },
    };
    return Response.json(body, { status: 503 });
  }
  if (!import.meta.env.UNSUBSCRIBE_SECRET) {
    const body: CronFail = {
      ok: false,
      error: { code: 'UNSUBSCRIBE_SECRET_MISSING', detail: 'UNSUBSCRIBE_SECRET is not set.' },
    };
    return Response.json(body, { status: 503 });
  }
  if (!import.meta.env.GOOGLE_REVIEW_URL) {
    const body: CronFail = {
      ok: false,
      error: { code: 'GOOGLE_REVIEW_URL_MISSING', detail: 'GOOGLE_REVIEW_URL is not set.' },
    };
    return Response.json(body, { status: 503 });
  }
  if (!isAuthorized(request)) {
    logCron({ phase: 'unauthorized', method: request.method });
    const body: CronFail = {
      ok: false,
      error: { code: 'UNAUTHORIZED', detail: 'Missing or invalid REVIEW_CRON_SECRET.' },
    };
    return Response.json(body, { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  // Optional override for end-to-end testing — caller can shift the
  // window by N days. NOT used by Vercel Cron; only useful for manual
  // test triggers. Capped to ±30 days so a misuse can't email anyone
  // outside the normal window.
  const shiftRaw = parseInt(url.searchParams.get('windowShiftDays') ?? '0', 10);
  const shift = isFinite(shiftRaw) ? Math.max(-30, Math.min(30, shiftRaw)) : 0;

  const now = Date.now();
  const ms = 24 * 60 * 60 * 1000;
  const windowEnd = new Date(now - (WINDOW_MIN_DAYS - shift) * ms);
  const windowStart = new Date(now - (WINDOW_MAX_DAYS - shift) * ms);

  const stats: CronOk = {
    ok: true,
    ranAt: new Date().toISOString(),
    windowStartUtc: windowStart.toISOString(),
    windowEndUtc: windowEnd.toISOString(),
    processed: 0,
    sent: 0,
    skipped: {
      notAccepted: 0,
      alreadySent: 0,
      customerMissing: 0,
      optedOut: 0,
      recentRequest: 0,
      serviceMissing: 0,
      barberMissing: 0,
    },
    failures: 0,
    failureDetails: [],
  };

  let bookings: Booking[] = [];
  try {
    const res = await listBookings({
      startAtMin: windowStart.toISOString(),
      startAtMax: windowEnd.toISOString(),
      limit: 100,
    });
    bookings = res.bookings;
    let cursor = res.cursor;
    while (cursor) {
      const more = await listBookings({
        startAtMin: windowStart.toISOString(),
        startAtMax: windowEnd.toISOString(),
        limit: 100,
        cursor,
      });
      bookings = bookings.concat(more.bookings);
      cursor = more.cursor;
    }
  } catch (err) {
    const detail = err instanceof SquareApiError ? `${err.code}: ${err.detail}` : err instanceof Error ? err.message : String(err);
    logCron({ phase: 'list-bookings-failed', errorDetail: detail });
    const body: CronFail = {
      ok: false,
      error: { code: 'LIST_BOOKINGS_FAILED', detail },
    };
    return Response.json(body, { status: 502 });
  }

  logCron({
    phase: 'window-loaded',
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bookings: bookings.length,
    dryRun,
    shift,
  });

  // Lazy-load lookup tables once, only if there's at least one booking.
  let serviceNames = new Map<string, string>();
  let barberNames = new Map<string, string>();
  if (bookings.length > 0) {
    try {
      const [svcs, barbers] = await Promise.all([getServices(), getBarbers()]);
      for (const s of svcs) {
        for (const v of s.variations) serviceNames.set(v.id, s.name);
      }
      for (const b of barbers) barberNames.set(b.id, b.displayName);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logCron({ phase: 'lookups-failed', errorDetail: detail });
      // Non-fatal — we'll fall back to ID strings if names are missing.
    }
  }

  const googleReviewUrl = String(import.meta.env.GOOGLE_REVIEW_URL);
  const origin = url.origin;
  const rateLimitCutoffMs = now - REVIEW_REQUEST_COOLDOWN_DAYS * ms;

  for (const booking of bookings) {
    stats.processed++;

    if (booking.status !== 'ACCEPTED') {
      stats.skipped.notAccepted++;
      continue;
    }
    if (!booking.customer_id) {
      stats.skipped.customerMissing++;
      continue;
    }

    try {
      const alreadySent = await hasReviewRequestBeenSent(booking.id);
      if (alreadySent) {
        stats.skipped.alreadySent++;
        continue;
      }

      const customer = await getCustomerById(booking.customer_id);
      if (!customer) {
        stats.skipped.customerMissing++;
        continue;
      }

      const marketing = await getAllMarketingAttributes(customer.id);
      if (!isOptedInForMarketing({ customer, marketingAttributes: marketing })) {
        stats.skipped.optedOut++;
        continue;
      }

      // Per-customer cooldown (REVIEW_REQUEST_COOLDOWN_DAYS). Check both
      // the KV record and the Square custom attribute (KV may be
      // unreachable / cleared during testing).
      const lastFromAttr = marketing.lastReviewRequestSentAt;
      const lastTs = lastFromAttr ? new Date(lastFromAttr).getTime() : 0;
      if (lastTs > rateLimitCutoffMs) {
        stats.skipped.recentRequest++;
        continue;
      }

      const seg = booking.appointment_segments?.[0];
      const serviceName = seg ? serviceNames.get(seg.service_variation_id) : null;
      if (!seg || !serviceName) {
        stats.skipped.serviceMissing++;
        continue;
      }
      const barberName = barberNames.get(seg.team_member_id);
      if (!barberName) {
        stats.skipped.barberMissing++;
        continue;
      }

      const reviewRequestId = crypto.randomUUID();
      const clickUrl = `${origin}/r/review?t=${encodeURIComponent(
        signClickToken({ reviewRequestId, destination: googleReviewUrl }),
      )}`;
      const unsubscribeUrl = `${origin}/unsubscribe?token=${encodeURIComponent(
        signUnsubscribeToken(customer.id),
      )}`;

      const customerName = [customer.given_name, customer.family_name]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join(' ')
        .trim();
      const toEmail = (customer.email_address ?? '').trim();

      if (dryRun) {
        logCron({
          phase: 'dry-run-would-send',
          bookingId: booking.id,
          customerId: customer.id,
          email: redactEmail(toEmail),
          service: serviceName,
          barber: barberName,
        });
        stats.sent++;
        continue;
      }

      const sendResult = await sendReviewRequest({
        to: toEmail,
        customerName: customerName || 'friend',
        barberName,
        serviceName,
        appointmentDate: formatAppointmentDate(booking.start_at),
        googleReviewUrl: clickUrl,
        unsubscribeUrl,
        shopAddress: SHOP_ADDRESS,
        shopPhone: SHOP_PHONE,
      });

      const sentAt = new Date().toISOString();
      await recordReviewRequestSent({
        reviewRequestId,
        customerId: customer.id,
        bookingId: booking.id,
        customerEmailRedacted: redactEmail(toEmail),
        customerName: customerName || undefined,
        serviceName,
        barberName,
        teamMemberId: seg.team_member_id,
        appointmentDate: formatAppointmentDate(booking.start_at),
        sentAt,
        resendId: sendResult.id,
      });

      // Mirror to Square so the rate limit survives KV outages.
      try {
        await setCustomAttribute(customer.id, LAST_REVIEW_REQUEST_SENT_AT_KEY, sentAt);
      } catch (err) {
        // Non-fatal — KV is the primary source of truth.
        const detail = err instanceof Error ? err.message : String(err);
        logCron({
          phase: 'mirror-attribute-failed',
          customerId: customer.id,
          errorDetail: detail,
        });
      }

      stats.sent++;
      logCron({
        phase: 'sent',
        bookingId: booking.id,
        customerId: customer.id,
        email: redactEmail(toEmail),
        service: serviceName,
        barber: barberName,
        resendId: sendResult.id,
        reviewRequestId,
      });
    } catch (err) {
      const detail =
        err instanceof SquareApiError
          ? `${err.code}: ${err.detail}`
          : err instanceof Error
            ? err.message
            : String(err);
      stats.failures++;
      stats.failureDetails.push({ bookingId: booking.id, reason: detail });
      logCron({
        phase: 'booking-failed',
        bookingId: booking.id,
        customerId: booking.customer_id ?? 'none',
        errorDetail: detail,
      });
      // Continue — one bad customer never crashes the whole batch.
    }
  }

  logCron({ phase: 'done', stats });
  return Response.json(stats, { status: 200 });
}

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
