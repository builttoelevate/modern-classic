// POST /api/barber/time-off/one-off — add a single-occurrence block
// (e.g. "blocked Tuesday June 4, 10:00–11:00, Dentist").
//
// Auth: requireBarberSession. Block lands on the calling barber's
// store; a tampered teamMemberId can't redirect the write.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import { addOneOffBlock } from '../../../../lib/barber/timeBlocks';

export const prerender = false;

function logBarber(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

interface RequestBody {
  startUtc?: string;
  endUtc?: string;
  note?: string;
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const b = (body ?? {}) as RequestBody;
  const startUtc = typeof b.startUtc === 'string' ? b.startUtc.trim() : '';
  const endUtc = typeof b.endUtc === 'string' ? b.endUtc.trim() : '';
  const note = typeof b.note === 'string' ? b.note.trim() : undefined;
  if (!startUtc) return fail(400, 'BAD_REQUEST', 'startUtc is required.');
  if (!endUtc) return fail(400, 'BAD_REQUEST', 'endUtc is required.');

  try {
    const block = await addOneOffBlock(session.barberId, {
      startUtc,
      endUtc,
      note,
    });
    logBarber({
      phase: 'time-off-one-off-added',
      barberId: session.barberId,
      blockId: block.id,
      startUtc: block.startUtc,
      endUtc: block.endUtc,
    });
    return new Response(
      JSON.stringify({ ok: true, block }),
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
    // addOneOffBlock throws plain Errors with friendly messages for
    // validation problems; surface as 400 so the UI shows the text
    // inline.
    return fail(400, 'BAD_REQUEST', detail);
  }
};
