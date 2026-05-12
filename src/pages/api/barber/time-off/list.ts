// GET /api/barber/time-off — list the calling barber's current
// time-off blocks (one-off + recurring). Drives the "Time off" tab
// on /barber/dashboard render and the inline refresh after every
// create / delete.
//
// Auth: requireBarberSession. The Redis key is always
// mc:barber:blocks:{session.barberId} — a barber can never read
// someone else's blocks.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import { listBlocks } from '../../../../lib/barber/timeBlocks';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }
  try {
    const bundle = await listBlocks(session.barberId);
    return new Response(
      JSON.stringify({ ok: true, ...bundle }),
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
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 502 },
    );
  }
};
