// Phase 7 — daily review-request cron.
//
// Runs once a day (10 AM ET via vercel.json). Pulls bookings whose
// start_at is between (now - 5 days) and (now - 2 days), filters to
// ACCEPTED appointments, eligibility-checks each customer, and emails a
// Google review request to anyone who qualifies and hasn't already been
// asked for this booking. Idempotent — running it twice in a day must
// never double-send.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. We use
// REVIEW_CRON_SECRET (separate from the rebuild cron's CRON_SECRET) so
// the two can be rotated/disabled independently.
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

function isAuthorized(request: Request): boolean {
  const expected = import.meta.env.REVIEW_CRON_SECRET;
  if (typeof expected !== 'string' || !expected) return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const supplied = header.slice(7).trim();
  return constantTimeEqual(supplied, expected);
}

async function handle(request: Request): Promise<Response> {
  const expected = import.meta.env.REVIEW_CRON_SECRET;
  if (typeof expected !== 'string' || !expected) {
    logCron({ phase: 'misconfigured', detail: 'REVIEW_CRON_SECRET not set' });
    return Response.json(
      {
        ok: false,
        error: {
          code: 'CRON_NOT_CONFIGURED',
          detail: 'REVIEW_CRON_SECRET is not set. Set it in Vercel env vars.',
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
        error: { code: 'UNAUTHORIZED', detail: 'Missing or invalid REVIEW_CRON_SECRET.' },
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
