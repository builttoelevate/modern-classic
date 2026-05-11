import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { runReviewRequestCron } from '../../../../lib/square/reviewCron';

export const prerender = false;

// Admin-triggered review-request run. Body:
//   { dryRun?: boolean, windowShiftDays?: number }
//
// Wraps the same core function the daily cron uses, so /admin/reviews
// can show real send + skip-reason stats on demand without having to
// share the bearer token. Basic Auth — same admin password as every
// other /admin/* page.

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
  const dryRun = b.dryRun === true;
  const shiftRaw = typeof b.windowShiftDays === 'number' ? b.windowShiftDays : 0;
  const shiftDays = Math.max(-30, Math.min(30, isFinite(shiftRaw) ? shiftRaw : 0));

  const origin = new URL(request.url).origin;
  const result = await runReviewRequestCron({
    dryRun,
    shiftDays,
    origin,
    manuallyTriggered: true,
  });

  // The core function returns a discriminated union; preserve the
  // shape but always 200 — the admin UI surfaces the error.code in the
  // response panel, and we don't want a 502 status to make it look
  // like the admin endpoint itself broke.
  return Response.json(result, { status: 200 });
};
