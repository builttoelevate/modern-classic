// POST /api/barber/profile — barber self-service for the
// customer-facing SMS phone shown on Step 5 confirmation + /my-bookings.
//
// Body: { phoneE164: string }   (raw user input — 10-digit US, with
//                                or without formatting. Empty string
//                                clears the field.)
//
// Auth: barber session cookie (mc_barber_session). The session's
// barberId scopes the write — a barber can only set their own number,
// not another barber's. Admins (Michael) can already reset passwords
// for other barbers via /api/admin/barbers/reset-password; phone is
// barber-controlled by design.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../lib/auth/barberMiddleware';
import { updateAccountPhone } from '../../../lib/barber/accountStore';

export const prerender = false;

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

function logBarber(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
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
    body = await request.json().catch(() => ({}));
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;
  // Accept empty string to clear; null/undefined → treat as no change
  // would be ambiguous, so require the field present (even if empty).
  if (typeof b.phoneE164 !== 'string') {
    return fail(400, 'BAD_REQUEST', 'phoneE164 must be a string (empty string clears the field).');
  }
  const raw = b.phoneE164.trim();

  try {
    const updated = await updateAccountPhone(session.barberId, raw);
    if (!updated) {
      return fail(404, 'NOT_FOUND', 'Barber account not found.');
    }
    logBarber({
      phase: 'profile-phone-updated',
      barberId: session.barberId,
      cleared: !updated.phoneE164,
    });
    return new Response(
      JSON.stringify({ ok: true, phoneE164: updated.phoneE164 ?? null }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          // Sliding-refresh the session on a successful write.
          'Set-Cookie': refreshBarberSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error.';
    logBarber({ phase: 'profile-phone-update-failed', barberId: session.barberId, detail });
    return fail(400, 'BAD_REQUEST', detail);
  }
};
