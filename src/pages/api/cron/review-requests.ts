// Phase 7 — daily review-request cron.
//
// Runs once a day (10 AM ET via vercel.json). Pulls bookings whose
// start_at is between (now - 5 days) and (now - 2 days), filters to
// ACCEPTED appointments, eligibility-checks each customer, and emails a
// Google review request to anyone who qualifies and hasn't already been
// asked for this booking. Idempotent — running it twice in a day must
// never double-send.
//
// Auth: accepts EITHER bearer to support both invocation paths.
//   - Vercel Cron (vercel.json schedule) automatically attaches
//     `Authorization: Bearer ${CRON_SECRET}` to its requests — that's
//     the only secret Vercel knows about, and the same one the
//     /api/cron/rebuild endpoint relies on. So we accept CRON_SECRET
//     here too. Without this, Vercel's daily fire was silently 401'd
//     and emails only went out when an operator clicked "Run Now" in
//     /admin/reviews. (That bug shipped May 2026; this dual-accept is
//     the fix.)
//   - GitHub Actions backup (.github/workflows/daily-review-requests.yml)
//     fires 30 min after Vercel as belt-and-suspenders and uses
//     REVIEW_CRON_SECRET so the two paths can be rotated/disabled
//     independently if one leaks. The endpoint accepts that too.
//
// As long as ONE of the two env vars is set, the endpoint is
// considered configured. Both env vars are compared in constant time.
//
// The actual work lives in src/lib/square/reviewCron.ts so the admin
// "run now" diagnostic endpoint at /api/admin/reviews/run-now can call
// into the same logic without sharing the bearer token.

import type { APIRoute } from 'astro';
import { runReviewRequestCron } from '../../../lib/square/reviewCron';
import { getPublicOrigin } from '../../../lib/utils/origin';

export const prerender = false;

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

function acceptedSecrets(): string[] {
  // Order doesn't matter — we compare against each in constant time
  // and accept if either matches. CRON_SECRET first because Vercel's
  // daily fire is the primary path; REVIEW_CRON_SECRET is the GH
  // Actions backup.
  const candidates = [
    import.meta.env.CRON_SECRET,
    import.meta.env.REVIEW_CRON_SECRET,
  ];
  return candidates.filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

function isAuthorized(request: Request): boolean {
  const accepted = acceptedSecrets();
  if (accepted.length === 0) return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const supplied = header.slice(7).trim();
  // Walk the full list every time — short-circuiting on first match
  // would leak which secret matched via timing. The list is at most
  // two entries; cost is negligible.
  let matched = false;
  for (const expected of accepted) {
    if (constantTimeEqual(supplied, expected)) matched = true;
  }
  return matched;
}

async function handle(request: Request): Promise<Response> {
  if (acceptedSecrets().length === 0) {
    logCron({
      phase: 'misconfigured',
      detail: 'Neither CRON_SECRET nor REVIEW_CRON_SECRET is set',
    });
    return Response.json(
      {
        ok: false,
        error: {
          code: 'CRON_NOT_CONFIGURED',
          detail:
            'Neither CRON_SECRET nor REVIEW_CRON_SECRET is set. Vercel injects CRON_SECRET automatically; set one of them in the Vercel env vars.',
        },
      },
      { status: 503 },
    );
  }
  if (!isAuthorized(request)) {
    logCron({ phase: 'unauthorized', method: request.method });
    return Response.json(
      {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          detail: 'Missing or invalid bearer (CRON_SECRET / REVIEW_CRON_SECRET).',
        },
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const shiftDays = parseInt(url.searchParams.get('windowShiftDays') ?? '0', 10);

  const result = await runReviewRequestCron({
    dryRun,
    shiftDays: isFinite(shiftDays) ? shiftDays : 0,
    // request.url on Vercel serverless resolves to the lambda's
    // internal host (typically http://localhost), which used to
    // leak into every review email's click link. getPublicOrigin
    // reads Vercel's x-forwarded-* headers for the real public
    // domain.
    origin: getPublicOrigin(request),
    manuallyTriggered: false,
  });

  if (!result.ok) {
    const status = result.error.code === 'LIST_BOOKINGS_FAILED' ? 502 : 503;
    return Response.json(result, { status });
  }
  return Response.json(result, { status: 200 });
}

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
