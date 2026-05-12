// POST /api/admin/reviews/send-test — send a single review-request
// email to an arbitrary inbox so the admin can preview what the
// real email looks like, without involving any customer record,
// booking, or dedupe state.
//
// Body: { to: string }   (recipient email; admin enters their own
//                         address to preview, or a teammate's)
//
// Critical: this does NOT call recordReviewRequestSent (so it
// doesn't pollute the per-booking dedupe store) and does NOT
// touch any Square customer attribute. It's a pure "render the
// template + send via Resend" preview. No future cron run is
// affected by this test.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { sendReviewRequest } from '../../../../lib/email/resend';
import { signClickToken } from '../../../../lib/marketing/clickToken';
import { signUnsubscribeToken } from '../../../../lib/marketing/unsubscribeToken';

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

  // Synthetic IDs — used for the click/unsubscribe token signatures
  // so the links in the email validate. The reviewRequestId is a
  // throwaway uuid that isn't recorded anywhere, so clicking the
  // Google link from the test email won't show up in the admin
  // recent-requests list as a "clicked" event (kSent record was
  // never written).
  const reviewRequestId = crypto.randomUUID();
  // Synthetic customerId for the unsubscribe token. If the admin
  // clicks the unsubscribe link in the test email, it would
  // attempt to flip a "review unsubscribed" flag on a customer
  // that doesn't exist — harmless no-op.
  const syntheticCustomerId = 'test-' + crypto.randomUUID();

  const origin = new URL(request.url).origin;
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
      customerName: 'friend',
      barberName: 'Michael',
      serviceName: 'Haircut',
      appointmentDate: today,
      googleReviewUrl: clickUrl,
      unsubscribeUrl,
      shopAddress: SHOP_ADDRESS,
      shopPhone: SHOP_PHONE,
    });
    logAdmin({
      phase: 'review-test-email-sent',
      to,
      resendId: sendResult.id,
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
