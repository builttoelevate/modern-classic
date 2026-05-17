// Phase 7 — review-request cron core.
//
// The Vercel cron endpoint at /api/cron/review-requests and the
// admin "run now" diagnostic endpoint at /api/admin/reviews/run-now
// both call into runReviewRequestCron(). Extracting the work into a
// pure(-ish) function means Michael can trigger an on-demand run from
// /admin/reviews and see the same skip-reason stats the scheduled
// cron logs, without us having to expose the bearer token.

import { listBookings } from '../square/bookings';
import { getBarbers } from './team';
import { getServices } from './catalog';
import { getCustomerById } from './customers';
import {
  LAST_REVIEW_REQUEST_SENT_AT_KEY,
  getAllMarketingAttributes,
  setCustomAttribute,
} from './customAttributes';
import { isEligibleForReviewRequest } from '../marketing/eligibility';
import {
  hasReviewRequestBeenSent,
  recordReviewCronRun,
  recordReviewRequestSent,
  type LastCronRunSummary,
} from '../marketing/reviewLog';
import { signClickToken } from '../marketing/clickToken';
import { signUnsubscribeToken } from '../marketing/unsubscribeToken';
import { sendReviewRequest } from '../email/resend';
import { redactEmail } from '../booking/log';
import { SquareApiError } from './client';
import type { Booking } from './types';

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';
const REVIEW_REQUEST_COOLDOWN_DAYS = 180;
const WINDOW_MIN_DAYS = 2;
const WINDOW_MAX_DAYS = 5;

export interface ReviewCronStats {
  ok: true;
  ranAt: string;
  /** True when an admin clicked "Run now" from /admin/reviews — the
   *  scheduled cron leaves this false. Surfaced on the dashboard so
   *  Michael can tell apart "the scheduler ran at 10 AM" from "I
   *  triggered it manually for diagnostics". */
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
  failureDetails: Array<{ bookingId: string; reason: string }>;
}

export interface ReviewCronFail {
  ok: false;
  error: { code: string; detail: string };
}

export type ReviewCronResult = ReviewCronStats | ReviewCronFail;

export interface RunReviewCronOptions {
  dryRun: boolean;
  /** Optional shift of the lookback window by N days. Useful for
   *  manual testing — capped at ±30. */
  shiftDays?: number;
  /** Origin used to build CTA + unsubscribe URLs.
   *  e.g. 'https://modernclassicbarbershop.com'. */
  origin: string;
  /** Whether to mark this as a manual run in the stats. */
  manuallyTriggered?: boolean;
}

function logCron(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[REVIEW-CRON] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function formatAppointmentDate(startAtUtc: string): string {
  const d = new Date(startAtUtc);
  if (isNaN(d.getTime())) return startAtUtc;
  // Day-of-week only ("Thursday") — the review cron's window is 2-5
  // days back from now, so the customer reads "Thanks for coming in
  // Thursday" as the natural, recent visit. Full dates like
  // "Thursday, May 14, 2026" read as a mail-merge template and hurt
  // the 1:1 deliverability angle.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
  }).format(d);
}

/** Build a minimal LastCronRunSummary for a failure result that didn't
 *  even get to processing — used so the dashboard can show "the cron
 *  ran but bailed because env X is missing" instead of "0 sent." */
function failureSummary(opts: {
  manuallyTriggered: boolean;
  dryRun: boolean;
  error: { code: string; detail: string };
}): LastCronRunSummary {
  const stub = new Date(0).toISOString();
  return {
    ranAt: new Date().toISOString(),
    manuallyTriggered: opts.manuallyTriggered,
    dryRun: opts.dryRun,
    windowStartUtc: stub,
    windowEndUtc: stub,
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
    error: opts.error,
  };
}

async function persistSummary(summary: LastCronRunSummary): Promise<void> {
  // Best-effort. The cron's primary side effects (sending email,
  // updating Square attributes) already succeeded by the time we
  // get here; if KV is unreachable we don't want to retry-loop the
  // run or surface a 500 to the caller.
  try {
    await recordReviewCronRun(summary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logCron({ phase: 'last-run-persist-failed', errorDetail: detail });
  }
}

export async function runReviewRequestCron(
  opts: RunReviewCronOptions,
): Promise<ReviewCronResult> {
  const manuallyTriggered = Boolean(opts.manuallyTriggered);
  const unsubscribeSecret = import.meta.env.UNSUBSCRIBE_SECRET;
  if (typeof unsubscribeSecret !== 'string' || unsubscribeSecret.length < 16) {
    const error = {
      code: 'UNSUBSCRIBE_SECRET_MISSING',
      detail: 'UNSUBSCRIBE_SECRET is not set. Set it in Vercel env vars.',
    };
    await persistSummary(failureSummary({ manuallyTriggered, dryRun: opts.dryRun, error }));
    return { ok: false, error };
  }
  const googleReviewUrlEnv = import.meta.env.GOOGLE_REVIEW_URL;
  if (typeof googleReviewUrlEnv !== 'string' || !googleReviewUrlEnv.startsWith('http')) {
    const error = {
      code: 'GOOGLE_REVIEW_URL_MISSING',
      detail: 'GOOGLE_REVIEW_URL is not set (or not a valid URL). Set it in Vercel env vars.',
    };
    await persistSummary(failureSummary({ manuallyTriggered, dryRun: opts.dryRun, error }));
    return { ok: false, error };
  }
  const googleReviewUrl = String(googleReviewUrlEnv);

  const shift = isFinite(opts.shiftDays ?? 0)
    ? Math.max(-30, Math.min(30, opts.shiftDays ?? 0))
    : 0;

  const now = Date.now();
  const ms = 24 * 60 * 60 * 1000;
  const windowEnd = new Date(now - (WINDOW_MIN_DAYS - shift) * ms);
  const windowStart = new Date(now - (WINDOW_MAX_DAYS - shift) * ms);

  const stats: ReviewCronStats = {
    ok: true,
    ranAt: new Date().toISOString(),
    manuallyTriggered: Boolean(opts.manuallyTriggered),
    dryRun: opts.dryRun,
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
    const detail =
      err instanceof SquareApiError
        ? `${err.code}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : String(err);
    logCron({ phase: 'list-bookings-failed', errorDetail: detail });
    const error = { code: 'LIST_BOOKINGS_FAILED', detail };
    await persistSummary(failureSummary({ manuallyTriggered, dryRun: opts.dryRun, error }));
    return { ok: false, error };
  }

  logCron({
    phase: 'window-loaded',
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bookings: bookings.length,
    dryRun: opts.dryRun,
    manuallyTriggered: stats.manuallyTriggered,
    shift,
  });

  const serviceNames = new Map<string, string>();
  const barberNames = new Map<string, string>();
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
    }
  }

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
      // Review requests are transactional — we do NOT require the
      // marketing consent checkbox. The per-channel unsubscribe link
      // in the review email itself is the customer's opt-out path.
      if (!isEligibleForReviewRequest({ customer, marketingAttributes: marketing })) {
        stats.skipped.optedOut++;
        continue;
      }

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
      const clickUrl = `${opts.origin}/r/review?t=${encodeURIComponent(
        signClickToken({ reviewRequestId, destination: googleReviewUrl }),
      )}`;
      // scope=review so clicking the link in a post-visit review email
      // opts the customer out of REVIEW REQUESTS specifically — not
      // every marketing email we might send them later. Per CAN-SPAM,
      // the per-channel opt-out is what the link is for.
      const unsubscribeUrl = `${opts.origin}/unsubscribe?token=${encodeURIComponent(
        signUnsubscribeToken(customer.id),
      )}&scope=review`;

      const customerName = [customer.given_name, customer.family_name]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join(' ')
        .trim();
      const toEmail = (customer.email_address ?? '').trim();

      if (opts.dryRun) {
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

      try {
        await setCustomAttribute(customer.id, LAST_REVIEW_REQUEST_SENT_AT_KEY, sentAt);
      } catch (err) {
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
    }
  }

  logCron({ phase: 'done', stats });
  await persistSummary({
    ranAt: stats.ranAt,
    manuallyTriggered: stats.manuallyTriggered,
    dryRun: stats.dryRun,
    windowStartUtc: stats.windowStartUtc,
    windowEndUtc: stats.windowEndUtc,
    processed: stats.processed,
    sent: stats.sent,
    skipped: stats.skipped,
    failures: stats.failures,
  });
  return stats;
}
