// GET /api/barber/availability — slot search scoped to the calling
// barber. Used by the /barber/dashboard "Schedule from waitlist"
// flow so a barber can see their own openings inline on the
// waitlist row.
//
// Mirrors the customer-side /api/square/availability shape but PINS
// teamMemberId to the calling barber's session — a barber can't
// search someone else's chair, defense-in-depth against a tampered
// query string.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../lib/auth/barberMiddleware';
import { searchAvailability } from '../../../lib/square/availability';
import { SquareApiError } from '../../../lib/square/client';

export const prerender = false;

function badRequest(message: string): Response {
  return Response.json(
    { ok: false, error: { code: 'BAD_REQUEST', detail: message } },
    { status: 400 },
  );
}

export const GET: APIRoute = async ({ request, url }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  const params = url.searchParams;
  const serviceVariationId = params.get('serviceVariationId') ?? '';
  const startAtRaw = params.get('startAt') ?? '';
  const endAtRaw = params.get('endAt') ?? '';

  if (!serviceVariationId) return badRequest('serviceVariationId is required');
  if (!startAtRaw) return badRequest('startAt is required (ISO UTC)');
  if (!endAtRaw) return badRequest('endAt is required (ISO UTC)');

  const startAt = new Date(startAtRaw);
  const endAt = new Date(endAtRaw);
  if (isNaN(startAt.getTime())) return badRequest('startAt is not a valid ISO date');
  if (isNaN(endAt.getTime())) return badRequest('endAt is not a valid ISO date');

  try {
    const slots = await searchAvailability({
      serviceVariationId,
      // Pinned to session — query-string teamMemberId is ignored.
      teamMemberId: session.barberId,
      startAt,
      endAt,
    });
    return new Response(
      JSON.stringify({ ok: true, slots }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshBarberSessionCookie(session),
        },
      },
    );
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail } },
        { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
      );
    }
    if (err instanceof Error) return badRequest(err.message);
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Unknown error' } },
      { status: 500 },
    );
  }
};
