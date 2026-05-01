// Phase 7 — one-shot admin endpoint that ensures the marketing-related
// Square Customer Custom Attribute definitions exist. Idempotent. Run once
// after deployment (or whenever this list changes).

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import { ensureCustomAttributeDefinitions } from '../../../lib/square/customAttributes';
import { SquareApiError } from '../../../lib/square/client';

export const prerender = false;

async function handle(request: Request): Promise<Response> {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  try {
    const result = await ensureCustomAttributeDefinitions();
    return Response.json(
      {
        ok: true,
        created: result.created,
        existed: result.existed,
        ranAt: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        {
          ok: false,
          error: { code: err.code, detail: err.detail, status: err.status },
        },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }
}

export const POST: APIRoute = ({ request }) => handle(request);
export const GET: APIRoute = ({ request }) => handle(request);
