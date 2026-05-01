// Phase 7 — review-CTA click-tracking redirect.
//
// URL: /r/review?t=<signed click token>
//
// We never block the customer's path: an invalid/missing token still
// redirects to the configured GOOGLE_REVIEW_URL (or the homepage if even
// that's missing). Click tracking is best-effort — failing to log must
// not surface as an error to the customer.

import type { APIRoute } from 'astro';
import { verifyClickToken } from '../../lib/marketing/clickToken';
import { recordReviewRequestClicked } from '../../lib/marketing/reviewLog';

export const prerender = false;

const FALLBACK = 'https://mdrnclassic.com/';

function pickFallback(): string {
  const cfg = import.meta.env.GOOGLE_REVIEW_URL;
  if (typeof cfg === 'string' && cfg.startsWith('http')) return cfg;
  return FALLBACK;
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
      await recordReviewRequestClicked(reviewRequestId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown error';
      // eslint-disable-next-line no-console
      console.log(
        `[REVIEW] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'click-log-failed',
          reviewRequestId,
          errorDetail: detail,
        })}`,
      );
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
