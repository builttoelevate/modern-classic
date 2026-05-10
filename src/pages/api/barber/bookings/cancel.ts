import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import {
  BarberAuthRequiredError,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import { SquareApiError } from '../../../../lib/square/client';
import { cancelBooking, getBooking } from '../../../../lib/square/bookings';

export const prerender = false;

// Barber-initiated cancel. Mirrors the admin cancel endpoint but
// gated by a barber session and with an ownership check: barbers may
// only cancel bookings whose team_member_id matches their own. No
// 24-hour gate, no card-on-file auto-charge — these are internal
// shop actions and the barber is presumed to have already coordinated
// with the customer.

function logAction(payload: Record<string, unknown>): void {
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
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const bookingId = typeof b.bookingId === 'string' ? b.bookingId.trim() : '';
  if (!bookingId) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'bookingId is required.' } },
      { status: 400 },
    );
  }

  let booking;
  try {
    booking = await getBooking(bookingId);
  } catch (err) {
    if (err instanceof SquareApiError && (err.status === 404 || err.code === 'NOT_FOUND')) {
      return Response.json(
        { ok: false, error: { code: 'NOT_FOUND', detail: 'Booking not found.' } },
        { status: 404 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'barber-cancel-fetch-failed', bookingId, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not load booking.' } },
      { status: 500 },
    );
  }

  // Ownership: only the booking's assigned barber can cancel it.
  const assigned = booking.appointment_segments?.[0]?.team_member_id;
  if (!assigned || assigned !== session.barberId) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          detail: "You can only cancel your own appointments.",
        },
      },
      { status: 403 },
    );
  }

  const idempotencyKey = `mc-barber-cancel-${createHash('sha256')
    .update(`${booking.id}|${booking.version}|${session.barberId}`)
    .digest('hex')}`;

  try {
    const cancelled = await cancelBooking({
      bookingId: booking.id,
      bookingVersion: booking.version,
      idempotencyKey,
    });
    logAction({
      phase: 'barber-cancel-success',
      bookingId: cancelled.id,
      barberId: session.barberId,
      customerId: booking.customer_id,
    });
    return Response.json({ ok: true, bookingId: cancelled.id, status: cancelled.status });
  } catch (err) {
    if (err instanceof SquareApiError) {
      logAction({
        phase: 'barber-cancel-square-error',
        bookingId,
        code: err.code,
        detail: err.detail,
      });
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail || 'Square rejected the cancel.' } },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'barber-cancel-failed', bookingId, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not cancel booking.' } },
      { status: 500 },
    );
  }
};
