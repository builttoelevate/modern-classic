import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { SquareApiError } from '../../../../lib/square/client';
import { getBooking, cancelBooking } from '../../../../lib/square/bookings';

export const prerender = false;

// Admin-side cancel — fired from /admin/customers after Michael looks
// up a customer and decides to scrap one of their appointments.
//
// Differs from the customer-side cancel at /api/square/bookings/[id]/
// cancel.ts in three ways:
//   1. Auth is HTTP Basic (admin), not session cookie + ownership.
//   2. No 24-hour gate — Michael is the shop, of course he can cancel.
//   3. No automatic late-cancel charge. If a charge is appropriate,
//      Michael uses the existing "Mark no-show & charge" action which
//      records the charge intent explicitly. Cancelling here is purely
//      a slot release.

function logAction(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

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
    logAction({ phase: 'admin-cancel-fetch-failed', bookingId, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not load booking.' } },
      { status: 500 },
    );
  }

  const idempotencyKey = `mc-admin-cancel-${createHash('sha256')
    .update(`${booking.id}|${booking.version}`)
    .digest('hex')}`;

  try {
    const cancelled = await cancelBooking({
      bookingId: booking.id,
      bookingVersion: booking.version,
      idempotencyKey,
    });
    logAction({
      phase: 'admin-cancel-success',
      bookingId: cancelled.id,
      customerId: booking.customer_id,
    });
    return Response.json({ ok: true, bookingId: cancelled.id, status: cancelled.status });
  } catch (err) {
    if (err instanceof SquareApiError) {
      logAction({
        phase: 'admin-cancel-square-error',
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
    logAction({ phase: 'admin-cancel-failed', bookingId, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not cancel booking.' } },
      { status: 500 },
    );
  }
};
