import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { SquareApiError } from '../../../../lib/square/client';
import { cancelBooking, createBooking, getBooking } from '../../../../lib/square/bookings';

export const prerender = false;

// Admin-side reschedule — fired from /admin/customers after Michael
// looks up a customer and wants to move one of their appointments.
//
// Strategy mirrors the customer-side reschedule at
// /api/square/bookings/reschedule.ts: create the new booking first, then
// cancel the old one. If the create fails, the old booking is intact.
// If the create succeeds but the cancel fails, the customer has the new
// booking and the response includes a warning so admin can clean up the
// stale row manually.
//
// Differences from the customer flow:
//   1. Auth is HTTP Basic (admin), not session cookie + ownership.
//   2. No 24-hour gate.
//   3. Service stays the same (read from the existing booking). Barber
//      may be swapped via teamMemberId. Service swap = cancel + rebook.

interface AdminReschedulePayload {
  oldBookingId: string;
  newStartAtUtc: string;
  /** Optional barber swap. Defaults to the existing booking's barber. */
  teamMemberId?: string;
}

function isValidPayload(p: unknown): p is AdminReschedulePayload {
  if (!p || typeof p !== 'object') return false;
  const r = p as Partial<AdminReschedulePayload>;
  if (typeof r.oldBookingId !== 'string' || !r.oldBookingId) return false;
  if (typeof r.newStartAtUtc !== 'string') return false;
  if (isNaN(new Date(r.newStartAtUtc).getTime())) return false;
  if (r.teamMemberId !== undefined && typeof r.teamMemberId !== 'string') return false;
  return true;
}

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
  if (!isValidPayload(body)) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Missing required fields.' } },
      { status: 400 },
    );
  }
  const payload = body;

  let oldBooking;
  try {
    oldBooking = await getBooking(payload.oldBookingId);
  } catch (err) {
    if (err instanceof SquareApiError && (err.status === 404 || err.code === 'NOT_FOUND')) {
      return Response.json(
        { ok: false, error: { code: 'NOT_FOUND', detail: 'Original booking not found.' } },
        { status: 404 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'admin-reschedule-fetch-failed', detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not load original booking.' } },
      { status: 500 },
    );
  }

  const segment = oldBooking.appointment_segments?.[0];
  if (!segment) {
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Booking has no service segment.' } },
      { status: 500 },
    );
  }
  if (!oldBooking.customer_id) {
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Booking has no customer.' } },
      { status: 500 },
    );
  }

  const teamMemberId = payload.teamMemberId?.trim() || segment.team_member_id;

  // Idempotent on (oldBookingId, newStart, teamMember). Re-submitting the
  // same reschedule produces the same Square booking instead of two.
  const newBookingIdemKey = `mc-admin-resched-${createHash('sha256')
    .update(`${payload.oldBookingId}|${payload.newStartAtUtc}|${teamMemberId}`)
    .digest('hex')}`;

  let newBookingId: string;
  let newBookingVersion: number;
  try {
    const newBooking = await createBooking({
      startAtUtc: payload.newStartAtUtc,
      customerId: oldBooking.customer_id,
      serviceVariationId: segment.service_variation_id,
      serviceVariationVersion: segment.service_variation_version,
      teamMemberId,
      durationMinutes: segment.duration_minutes,
      customerNote: oldBooking.customer_note,
      idempotencyKey: newBookingIdemKey,
    });
    newBookingId = newBooking.id;
    newBookingVersion = newBooking.version;
    logAction({
      phase: 'admin-reschedule-new-created',
      oldBookingId: payload.oldBookingId,
      newBookingId,
      customerId: oldBooking.customer_id,
    });
  } catch (err) {
    if (err instanceof SquareApiError) {
      logAction({
        phase: 'admin-reschedule-create-failed',
        oldBookingId: payload.oldBookingId,
        code: err.code,
        detail: err.detail,
      });
      const slotTaken =
        err.code === 'BOOKING_CONFLICT' ||
        err.code === 'TIME_CONFLICT' ||
        err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
        /already.*book|conflict|not available|overlap/i.test(`${err.code} ${err.detail}`);
      const status = slotTaken ? 409 : err.status >= 400 && err.status < 600 ? err.status : 502;
      return Response.json(
        {
          ok: false,
          error: {
            code: err.code,
            detail: slotTaken
              ? 'That slot was just taken — please pick another.'
              : err.detail || 'Could not create the new booking.',
            slotTaken,
          },
        },
        { status },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'admin-reschedule-create-error', detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not create new booking.' } },
      { status: 500 },
    );
  }

  const cancelIdemKey = `mc-admin-resched-cancel-${createHash('sha256')
    .update(`${oldBooking.id}|${oldBooking.version}|${newBookingId}`)
    .digest('hex')}`;
  try {
    await cancelBooking({
      bookingId: oldBooking.id,
      bookingVersion: oldBooking.version,
      idempotencyKey: cancelIdemKey,
    });
    logAction({
      phase: 'admin-reschedule-old-cancelled',
      oldBookingId: oldBooking.id,
      newBookingId,
    });
    return Response.json({
      ok: true,
      newBookingId,
      newBookingVersion,
      oldBookingId: oldBooking.id,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAction({
      phase: 'admin-reschedule-cancel-failed',
      severity: 'manual-cleanup-needed',
      oldBookingId: oldBooking.id,
      newBookingId,
      detail,
    });
    return Response.json({
      ok: true,
      newBookingId,
      newBookingVersion,
      oldBookingId: oldBooking.id,
      warning:
        'New appointment booked, but the old one could not be cancelled automatically — cancel it manually.',
    });
  }
};
