// Phase 6 Part D — daily catalog rebuild trigger.
//
// Vercel Cron hits this once a day at 4-5 AM ET (8 AM UTC, see
// vercel.json). Authentication: Vercel attaches `Authorization: Bearer
// <CRON_SECRET>` automatically per
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
//
// On a hit, we POST to a Vercel deploy hook URL stored in env. That kicks
// off a fresh build, which re-runs services.astro's getServices() call so
// any catalog edits Michael made since the last build land in production.

import type { APIRoute } from 'astro';

export const prerender = false;

interface CronOk {
  ok: true;
  triggeredAt: string;
  hookStatus?: number;
}

interface CronFail {
  ok: false;
  error: { code: string; detail: string };
}

function logCron(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[CRON] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function isAuthorized(request: Request): boolean {
  const expected = import.meta.env.CRON_SECRET;
  if (typeof expected !== 'string' || !expected) return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const supplied = header.slice(7).trim();
  if (supplied.length !== expected.length) return false;
  // Constant-time compare.
  let mismatch = 0;
  for (let i = 0; i < supplied.length; i++) {
    mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

async function handle(request: Request): Promise<Response> {
  const cronSecret = import.meta.env.CRON_SECRET;
  if (!cronSecret) {
    const body: CronFail = {
      ok: false,
      error: { code: 'CRON_NOT_CONFIGURED', detail: 'CRON_SECRET is not set.' },
    };
    return Response.json(body, { status: 503 });
  }
  if (!isAuthorized(request)) {
    logCron({ phase: 'unauthorized', method: request.method });
    const body: CronFail = {
      ok: false,
      error: { code: 'UNAUTHORIZED', detail: 'Missing or invalid CRON secret.' },
    };
    return Response.json(body, { status: 401 });
  }

  const hookUrl = import.meta.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    logCron({ phase: 'no-deploy-hook' });
    const body: CronFail = {
      ok: false,
      error: {
        code: 'DEPLOY_HOOK_NOT_CONFIGURED',
        detail: 'VERCEL_DEPLOY_HOOK_URL is not set.',
      },
    };
    return Response.json(body, { status: 503 });
  }

  let hookStatus = 0;
  try {
    const r = await fetch(hookUrl, { method: 'POST' });
    hookStatus = r.status;
    logCron({ phase: 'deploy-hook-fired', hookStatus });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logCron({ phase: 'deploy-hook-failed', detail });
    const body: CronFail = {
      ok: false,
      error: { code: 'DEPLOY_HOOK_FAILED', detail },
    };
    return Response.json(body, { status: 502 });
  }

  const body: CronOk = {
    ok: true,
    triggeredAt: new Date().toISOString(),
    hookStatus,
  };
  return Response.json(body, { status: 200 });
}

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
