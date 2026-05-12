import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { runReviewRequestCron } from '../../../../lib/square/reviewCron';
import { getPublicOrigin } from '../../../../lib/utils/origin';

export const prerender = false;

// Admin-triggered review-request run. Body:
//   {
//     dryRun?: boolean,           // required to be exactly false for a live run
//     confirmLive?: boolean,      // required to be exactly true for a live run
//     windowShiftDays?: number,
//   }
//
// Wraps the same core function the daily cron uses, so /admin/reviews
// can show real send + skip-reason stats on demand without having to
// share the bearer token. Basic Auth — same admin password as every
// other /admin/* page.
//
// **Fail-safe default**: requires TWO explicit flags
// (`dryRun: false` AND `confirmLive: true`) to actually send emails.
// Any other body shape — missing body, partial body, parse failure,
// either flag absent — falls through to a dry run. This guards
// against an iOS Safari quirk where a POST with JSON body can lose
// the body in transit (server sees an empty body, parses {} as
// default, and would previously have run live by default). With
// this guard, a lost body is harmless: the cron runs dry.

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

  // Live ONLY when both flags are explicit and unambiguous.
  // Everything else — including the iOS-lost-body case — is dry.
  const explicitLive = b.dryRun === false && b.confirmLive === true;
  const dryRun = !explicitLive;

  const shiftRaw = typeof b.windowShiftDays === 'number' ? b.windowShiftDays : 0;
  const shiftDays = Math.max(-30, Math.min(30, isFinite(shiftRaw) ? shiftRaw : 0));

  const origin = getPublicOrigin(request);
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
