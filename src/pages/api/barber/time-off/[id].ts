// DELETE /api/barber/time-off/{id} — remove a one-off or recurring
// block by id. Single endpoint for either kind because ids are
// unique across both arrays in the bundle.
//
// Auth: requireBarberSession. The delete walks the calling barber's
// own bundle — even if the id belonged to another barber the
// lookup wouldn't find it.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import { removeBlock } from '../../../../lib/barber/timeBlocks';

export const prerender = false;

function logBarber(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

export const DELETE: APIRoute = async ({ request, params }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }
  const id = typeof params.id === 'string' ? params.id.trim() : '';
  if (!id) return fail(400, 'BAD_REQUEST', 'Block id is required.');

  try {
    const removed = await removeBlock(session.barberId, id);
    logBarber({
      phase: removed ? 'time-off-removed' : 'time-off-remove-noop',
      barberId: session.barberId,
      blockId: id,
    });
    return new Response(
      JSON.stringify({ ok: true, removed }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshBarberSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return fail(502, 'INTERNAL', detail);
  }
};
