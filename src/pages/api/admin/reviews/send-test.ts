// POST /api/admin/reviews/send-test — send a single review-request
// email to an arbitrary inbox so the admin can preview what the
// real email looks like AND verify click tracking end-to-end.
//
// Body: { to: string, customerName?: string }
//
// Writes a `mc:review:sent:<test-uuid>` Redis record tagged
// `isTest: true` so the row shows up in the Recent list (admin can
// click the test email's CTA and watch the row flip to Clicked).
// The dashboard's headline counts EXCLUDE isTest rows so CTR stays
// accurate. Synthetic bookingId + customerId mean the test never
// touches the cron's per-booking dedupe or per-customer cooldown,
// AND never touches any Square customer attribute.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { sendReviewRequest } from '../../../../lib/email/resend';
import { signClickToken } from '../../../../lib/marketing/clickToken';
import { signUnsubscribeToken } from '../../../../lib/marketing/unsubscribeToken';
import { getPublicOrigin } from '../../../../lib/utils/origin';
import { recordReviewRequestSent } from '../../../../lib/marketing/reviewLog';
import { redactEmail } from '../../../../lib/booking/log';

export const prerender = false;

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
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
  const to = typeof b.to === 'string' ? b.to.trim() : '';
  if (!to) return fail(400, 'BAD_REQUEST', 'Recipient email is required.');
  if (!/^\S+@\S+\.\S+$/.test(to)) {
    return fail(400, 'BAD_REQUEST', 'Recipient email looks malformed.');
  }
  // Optional preview name. Blank → exercises the no-first-name path
  // in the template (greeting "Hey,", subject "How was your visit?").
  // Non-blank → "Hey {name}," / "How was your visit, {name}?".
  const customerName = typeof b.customerName === 'string' ? b.customerName.trim() : '';

  // Env checks — match what the cron requires so this surfaces the
  // same misconfiguration in the same place.
  const unsubscribeSecret = import.meta.env.UNSUBSCRIBE_SECRET;
  if (typeof unsubscribeSecret !== 'string' || unsubscribeSecret.length < 16) {
    return fail(
      503,
      'UNSUBSCRIBE_SECRET_MISSING',
      'UNSUBSCRIBE_SECRET is not set. Set it in Vercel env vars.',
    );
  }
  const googleReviewUrlEnv = import.meta.env.GOOGLE_REVIEW_URL;
  if (typeof googleReviewUrlEnv !== 'string' || !googleReviewUrlEnv.startsWith('http')) {
    return fail(
      503,
      'GOOGLE_REVIEW_URL_MISSING',
      'GOOGLE_REVIEW_URL is not set. Set it in Vercel env vars.',
    );
  }

  // Synthetic IDs — `test-` prefix on bookingId and customerId so
  // they can never collide with real Square IDs and so the cron's
  // per-booking dedupe + per-customer cooldown checks never read
  // anything that affects real customers. reviewRequestId is a fresh
  // uuid (no prefix needed — it's only ever looked up by token).
  const reviewRequestId = crypto.randomUUID();
  const syntheticCustomerId = 'test-' + crypto.randomUUID();
  const syntheticBookingId = 'test-' + crypto.randomUUID();

  const origin = getPublicOrigin(request);
  const clickUrl = `${origin}/r/review?t=${encodeURIComponent(
    signClickToken({ reviewRequestId, destination: googleReviewUrlEnv }),
  )}`;
  const unsubscribeUrl = `${origin}/unsubscribe?token=${encodeURIComponent(
    signUnsubscribeToken(syntheticCustomerId),
  )}&scope=review`;

  // Sample content. Today's date for the appointment so the copy
  // reads naturally as a recent visit.
  const today = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  try {
    const sendResult = await sendReviewRequest({
      to,
      customerName,
      barberName: 'Michael',
      serviceName: 'Haircut',
      appointmentDate: today,
      googleReviewUrl: clickUrl,
      unsubscribeUrl,
      shopAddress: SHOP_ADDRESS,
      shopPhone: SHOP_PHONE,
    });
    // Write the kSent record so a click on the test email's CTA
    // flips the row to Clicked in /admin/reviews. Failure here is
    // non-fatal — the email already shipped, the admin can still
    // verify by long-press / inbox; we just lose the dashboard
    // round-trip verification.
    try {
      await recordReviewRequestSent({
        reviewRequestId,
        customerId: syntheticCustomerId,
        bookingId: syntheticBookingId,
        customerEmailRedacted: redactEmail(to),
        customerName,
        serviceName: 'Haircut',
        barberName: 'Michael',
        appointmentDate: today,
        sentAt: new Date().toISOString(),
        resendId: sendResult.id,
        isTest: true,
      });
    } catch (logErr) {
      logAdmin({
        phase: 'review-test-record-failed',
        to,
        detail: logErr instanceof Error ? logErr.message : String(logErr),
      });
    }
    logAdmin({
      phase: 'review-test-email-sent',
      to,
      resendId: sendResult.id,
      reviewRequestId,
    });
    return Response.json({
      ok: true,
      to,
      resendId: sendResult.id,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown send error.';
    logAdmin({
      phase: 'review-test-email-failed',
      to,
      detail,
    });
    return fail(502, 'SEND_FAILED', detail);
  }
};
