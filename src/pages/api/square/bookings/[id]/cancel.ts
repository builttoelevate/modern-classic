import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { AuthRequiredError, requireSession, refreshSessionCookie } from '../../../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../../../lib/auth/session';
import { SquareApiError } from '../../../../../lib/square/client';
import { getBooking, cancelBooking } from '../../../../../lib/square/bookings';
import { redactEmail } from '../../../../../lib/booking/log';

export const prerender = false;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function logAction(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BOOK] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ params, request }) => {
  if (!isAuthConfigured()) {
    return Response.json(
      { ok: false, error: { code: 'AUTH_NOT_CONFIGURED', detail: 'Auth not configured.' } },
      { status: 503 },
    );
  }

  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }

  const id = params.id;
  if (!id || typeof id !== 'string') {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Booking id is required.' } },
      { status: 400 },
    );
  }

  let booking;
  try {
    booking = await getBooking(id);
  } catch (err) {
    if (err instanceof SquareApiError && (err.status === 404 || err.code === 'NOT_FOUND')) {
      return Response.json(
        { ok: false, error: { code: 'NOT_FOUND', detail: 'Booking not found.' } },
        { status: 404 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'cancel-fetch-failed', bookingId: id, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not load booking.' } },
      { status: 500 },
    );
  }

  if (!booking.customer_id || booking.customer_id !== session.customerId) {
    logAction({
      phase: 'cancel-forbidden',
      bookingId: id,
      sessionEmail: redactEmail(session.email),
    });
    return Response.json(
      { ok: false, error: { code: 'FORBIDDEN', detail: 'This booking does not belong to you.' } },
      { status: 403 },
    );
  }

  const startMs = new Date(booking.start_at).getTime();
  if (startMs - Date.now() < TWENTY_FOUR_HOURS_MS) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'TOO_LATE_TO_CANCEL',
          detail: 'Within 24 hours — please call the shop at 740-297-4462.',
        },
      },
      { status: 400 },
    );
  }

  const idempotencyKey = `mc-cancel-${createHash('sha256')
    .update(`${booking.id}|${booking.version}`)
    .digest('hex')}`;

  try {
    const cancelled = await cancelBooking({
      bookingId: booking.id,
      bookingVersion: booking.version,
      idempotencyKey,
    });
    logAction({
      phase: 'cancel-success',
      bookingId: cancelled.id,
      sessionEmail: redactEmail(session.email),
    });
    return new Response(
      JSON.stringify({ ok: true, bookingId: cancelled.id, status: cancelled.status }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshSessionCookie(session),
        },
      },
    );
  } catch (err) {
    if (err instanceof SquareApiError) {
      logAction({
        phase: 'cancel-square-error',
        bookingId: id,
        code: err.code,
        detail: err.detail,
        sessionEmail: redactEmail(session.email),
      });
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail || 'Square rejected the cancel.' } },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'cancel-failed', bookingId: id, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not cancel booking.' } },
      { status: 500 },
    );
  }
};
