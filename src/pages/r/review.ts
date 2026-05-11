// Phase 7 — review-CTA click-tracking redirect.
//
// URL: /r/review?t=<signed click token>
//
// We never block the customer's path: an invalid/missing token still
// redirects to the configured GOOGLE_REVIEW_URL (or the homepage if even
// that's missing). Click tracking is best-effort — failing to log must
// not surface as an error to the customer.
//
// On the FIRST click (clickedAt was null beforehand), we also fire a
// notification to the assigned barber's inbox so they know a review is
// likely incoming. Subsequent clicks don't re-notify.

import type { APIRoute } from 'astro';
import { verifyClickToken } from '../../lib/marketing/clickToken';
import { recordReviewRequestClicked } from '../../lib/marketing/reviewLog';
import { resolveBarberContact } from '../../lib/barber/contactLookup';
import { sendReviewClickBarber } from '../../lib/email/resend';

export const prerender = false;

const FALLBACK = 'https://mdrnclassic.com/';
const SHOP_PHONE = '740-297-4462';

function pickFallback(): string {
  const cfg = import.meta.env.GOOGLE_REVIEW_URL;
  if (typeof cfg === 'string' && cfg.startsWith('http')) return cfg;
  return FALLBACK;
}

function logReview(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[REVIEW] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get('t') ?? '';
  let destination = pickFallback();
  let reviewRequestId: string | null = null;

  if (token) {
    const verified = verifyClickToken(token);
    if (verified) {
      reviewRequestId = verified.reviewRequestId;
      // Use the destination from the signed token — it's HMAC-bound, so
      // we can trust it. Falls back to env GOOGLE_REVIEW_URL otherwise.
      if (verified.destination.startsWith('http')) {
        destination = verified.destination;
      }
    }
  }

  if (reviewRequestId) {
    try {
      const result = await recordReviewRequestClicked(reviewRequestId);
      // First-click only: notify the assigned barber so they know a
      // review is likely incoming. Skipped silently if the record was
      // created before teamMemberId tracking was added, or the barber
      // has no resolvable inbox. Subsequent clicks don't re-fire — we
      // don't want the barber pinged every time the customer revisits
      // the link.
      const teamMemberId = result?.record.teamMemberId;
      if (result && result.wasFirstClick && teamMemberId) {
        const record = result.record;
        const contact = await resolveBarberContact(teamMemberId).catch(() => null);
        if (contact) {
          try {
            const send = await sendReviewClickBarber({
              to: contact.email,
              barberDisplayName: contact.displayName,
              customerName: record.customerName || 'A customer',
              serviceName: record.serviceName,
              appointmentDate: record.appointmentDate || 'a recent appointment',
              googleReviewUrl: destination,
              shopPhone: SHOP_PHONE,
            });
            logReview({
              phase: 'click-barber-notify-sent',
              reviewRequestId,
              teamMemberId,
              resendId: send.id,
            });
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            logReview({
              phase: 'click-barber-notify-failed',
              reviewRequestId,
              teamMemberId,
              errorDetail: detail,
            });
          }
        } else {
          logReview({
            phase: 'click-barber-notify-skipped-no-email',
            reviewRequestId,
            teamMemberId,
          });
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown error';
      logReview({
        phase: 'click-log-failed',
        reviewRequestId,
        errorDetail: detail,
      });
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      'Cache-Control': 'no-store',
    },
  });
};
