// Hard reset for /admin/reviews. Wipes every sent record, the index,
// and the click-attempts log so the headline "X sent · Y clicked"
// reads "0 sent · 0 clicked" until fresh records are written.
//
// Cooldown state (kByCustomerLastClicked) and cron state (kLastRun)
// are deliberately preserved — see resetAllReviewStats() for why.
//
// Same fail-safe pattern as run-now / resend-broken: requires
// { confirmLive: true, dryRun: false } exactly. Any other body shape
// (including a missing flag from a tap that lost the payload) falls
// through to a dry-run that reports counts and changes nothing.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { getReviewStats, resetAllReviewStats } from '../../../../lib/marketing/reviewLog';

export const prerender = false;

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

  if (!explicitLive) {
    // Dry-run: report current totals so the operator sees what would
    // be wiped.
    const stats = await getReviewStats({ daysBack: 365, recentLimit: 1 });
    return Response.json(
      {
        ok: true,
        dryRun: true,
        currentTotals: { sent: stats.sent, clicked: stats.clicked },
        hint: 'POST with { "confirmLive": true, "dryRun": false } to actually wipe.',
      },
      { status: 200 },
    );
  }

  const result = await resetAllReviewStats();
  // eslint-disable-next-line no-console
  console.log(
    `[REVIEW-RESET] ${JSON.stringify({ ts: new Date().toISOString(), ...result })}`,
  );
  return Response.json({ ok: true, dryRun: false, deleted: result }, { status: 200 });
};
