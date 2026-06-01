// One-time admin endpoint to re-send review-request emails to customers
// whose original email contained the broken (pre-SITE_URL-fix) click
// URL — the per-deploy *.vercel.app host that was Deployment-Protection
// blocked, so customers couldn't actually leave a review even when
// they tried.
//
// Iterates every real review-request record in the configured window,
// looks up the customer's current email + opt-out state, and sends a
// FRESH email with a new reviewRequestId + a click URL that now points
// at the canonical domain. A new sent record is written for each so
// the new email is independently click-trackable.
//
// Fail-safe defaults: requires { confirmLive: true, dryRun: false }
// exactly — any other body shape (missing flag, parse failure, iOS
// Safari body-loss) falls through to a dry run that only reports
// counts and doesn't send a single email.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { getCustomerById } from '../../../../lib/square/customers';
import {
  getAllMarketingAttributes,
  setCustomAttribute,
  LAST_REVIEW_REQUEST_SENT_AT_KEY,
} from '../../../../lib/square/customAttributes';
import { isEligibleForReviewRequest } from '../../../../lib/marketing/eligibility';
import { signClickToken } from '../../../../lib/marketing/clickToken';
import { signUnsubscribeToken } from '../../../../lib/marketing/unsubscribeToken';
import { sendReviewRequest } from '../../../../lib/email/resend';
import { redactEmail } from '../../../../lib/booking/log';
import {
  listRecordsSince,
  recordReviewRequestSent,
} from '../../../../lib/marketing/reviewLog';
import { getPublicOrigin } from '../../../../lib/utils/origin';
import { SHOP_PHONE } from '../../../../lib/branding';

export const prerender = false;

const SHOP_TZ = 'America/New_York';
const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';

function formatAppointmentDate(iso?: string): string {
  if (!iso) return 'your recent visit';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'your recent visit';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

function log(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[REVIEW-RESEND] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json().catch(() => ({}));
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const explicitLive = b.dryRun === false && b.confirmLive === true;
  const dryRun = !explicitLive;
  const sinceDaysRaw = typeof b.sinceDays === 'number' ? b.sinceDays : 60;
  const sinceDays = Math.max(1, Math.min(180, Math.floor(sinceDaysRaw)));

  const googleReviewUrl = import.meta.env.GOOGLE_REVIEW_URL;
  if (typeof googleReviewUrl !== 'string' || !googleReviewUrl.startsWith('http')) {
    return Response.json(
      { ok: false, error: { code: 'GOOGLE_REVIEW_URL_MISSING', detail: 'GOOGLE_REVIEW_URL env var is not set.' } },
      { status: 500 },
    );
  }

  const origin = getPublicOrigin(request);
  const records = await listRecordsSince(sinceDays);
  // Skip rows created by /admin/reviews "Send test email" — those were
  // never real customer sends.
  const candidates = records.filter((r) => !r.isTest);

  const stats = {
    dryRun,
    sinceDays,
    origin,
    total: candidates.length,
    resent: 0,
    skippedNoCustomer: 0,
    skippedNoEmail: 0,
    skippedOptedOut: 0,
    failed: 0,
    failureDetails: [] as Array<{ customerId: string; reason: string }>,
  };

  log({ phase: 'start', dryRun, sinceDays, origin, total: candidates.length });

  for (const old of candidates) {
    try {
      const customer = await getCustomerById(old.customerId);
      if (!customer) {
        stats.skippedNoCustomer++;
        continue;
      }
      const toEmail = (customer.email_address ?? '').trim();
      if (!toEmail) {
        stats.skippedNoEmail++;
        continue;
      }
      const marketing = await getAllMarketingAttributes(customer.id);
      if (!isEligibleForReviewRequest({ customer, marketingAttributes: marketing })) {
        stats.skippedOptedOut++;
        continue;
      }

      if (dryRun) {
        log({ phase: 'dry-run-would-resend', customerId: customer.id, email: redactEmail(toEmail) });
        stats.resent++;
        continue;
      }

      const reviewRequestId = crypto.randomUUID();
      const clickUrl = `${origin}/r/review?t=${encodeURIComponent(
        signClickToken({ reviewRequestId, destination: googleReviewUrl }),
      )}`;
      const unsubscribeUrl = `${origin}/unsubscribe?token=${encodeURIComponent(
        signUnsubscribeToken(customer.id),
      )}&scope=review`;

      const customerName = [customer.given_name, customer.family_name]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join(' ')
        .trim();

      const sendResult = await sendReviewRequest({
        to: toEmail,
        customerName: customerName || 'friend',
        barberName: old.barberName,
        serviceName: old.serviceName,
        appointmentDate: formatAppointmentDate(old.appointmentDate),
        googleReviewUrl: clickUrl,
        unsubscribeUrl,
        shopAddress: SHOP_ADDRESS,
        shopPhone: SHOP_PHONE,
      });
      const sentAt = new Date().toISOString();
      await recordReviewRequestSent({
        reviewRequestId,
        customerId: customer.id,
        bookingId: old.bookingId,
        customerEmailRedacted: redactEmail(toEmail),
        customerName: customerName || undefined,
        serviceName: old.serviceName,
        barberName: old.barberName,
        teamMemberId: old.teamMemberId,
        appointmentDate: old.appointmentDate,
        sentAt,
        resendId: sendResult.id,
      });
      try {
        await setCustomAttribute(customer.id, LAST_REVIEW_REQUEST_SENT_AT_KEY, sentAt);
      } catch {
        // Non-fatal — KV is the source of truth for the cooldown.
      }
      stats.resent++;
      log({
        phase: 'resent',
        customerId: customer.id,
        oldReviewRequestId: old.reviewRequestId,
        newReviewRequestId: reviewRequestId,
        resendId: sendResult.id,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      stats.failed++;
      stats.failureDetails.push({ customerId: old.customerId, reason: detail });
      log({ phase: 'failed', customerId: old.customerId, detail });
    }
  }

  log({ phase: 'done', ...stats, failureDetails: undefined });
  return Response.json({ ok: true, stats }, { status: 200 });
};
