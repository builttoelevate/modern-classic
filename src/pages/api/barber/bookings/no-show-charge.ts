// Barber-initiated no-show charge. Owner-only — the gate is the
// shop's owner role (set via ROLE_BY_ID in src/lib/square/team.ts).
// Regular barbers report no-shows to Michael verbally; only he can
// fire the actual charge.
//
// Authorization differs from the other /api/barber/bookings/*
// endpoints: cancel/reschedule check `booking.team_member_id ===
// session.barberId`. This one does NOT — the owner needs to act on
// bookings assigned to other barbers, which is the entire point.
// The role gate is the only ownership check.
//
// Logic is identical to /api/admin/bookings/no-show-charge — both
// thin-wrap chargeNoShowBooking() in src/lib/booking/noShowCharge.ts.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import { isBarberOwner } from '../../../../lib/auth/barberPermissions';
import {
  NoShowChargeError,
  chargeNoShowBooking,
} from '../../../../lib/booking/noShowCharge';

export const prerender = false;

interface FailureResponse {
  ok: false;
  error: { code: string; detail: string };
}

function fail(status: number, code: string, detail: string): Response {
  const body: FailureResponse = { ok: false, error: { code, detail } };
  return Response.json(body, { status });
}

export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  if (!(await isBarberOwner(session.barberId))) {
    return fail(403, 'FORBIDDEN', 'Only the owner can charge no-shows.');
  }

  let bookingId: string;
  try {
    const body = (await request.json()) as { bookingId?: string };
    bookingId = (body.bookingId ?? '').trim();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  if (!bookingId) return fail(400, 'BAD_REQUEST', 'bookingId is required.');

  try {
    const result = await chargeNoShowBooking(bookingId);
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof NoShowChargeError) {
      const status =
        err.code === 'BOOKING_NOT_FOUND'
          ? 404
          : err.code === 'ALREADY_CHARGED'
            ? 409
            : err.code === 'FETCH_FAILED'
              ? 500
              : 400;
      return fail(status, err.code, err.detail);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail(500, 'INTERNAL', detail);
  }
};
