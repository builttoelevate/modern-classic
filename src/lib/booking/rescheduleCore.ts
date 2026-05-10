// Shared "create new booking, then cancel old" reschedule primitive,
// extracted from /api/admin/bookings/reschedule.ts so the admin endpoint
// and the new barber endpoint can share one well-tested implementation.
//
// Two-step atomicity: if the new booking can't be created, the old one
// is untouched. If the new booking lands but the cancel fails, the
// caller is told to clean up manually (the customer at least has the
// new appointment).

import { createHash } from 'node:crypto';
import { SquareApiError } from '../square/client';
import { cancelBooking, createBooking, getBooking } from '../square/bookings';
import type { Booking } from '../square/types';

export interface RescheduleInput {
  oldBookingId: string;
  newStartAtUtc: string;
  /** Optional barber swap. Defaults to the existing booking's barber. */
  teamMemberId?: string;
  /** Prefix used in the idempotency key so concurrent admin and
   *  barber retries don't collide. e.g. 'admin' or 'barber'. */
  actorPrefix: string;
}

export type RescheduleSuccess = {
  ok: true;
  newBookingId: string;
  newBookingVersion: number;
  oldBookingId: string;
  /** Set when the cancel-old step failed but the new booking did land. */
  warning?: string;
};

export type RescheduleFailure = {
  ok: false;
  status: number;
  error: {
    code: string;
    detail: string;
    /** True when the failure looks like the slot was just taken. */
    slotTaken?: boolean;
  };
};

export type RescheduleResult = RescheduleSuccess | RescheduleFailure;

/** Optional ownership hook. The barber endpoint passes a check that
 *  asserts the booking's team_member_id matches the logged-in barber;
 *  the admin endpoint omits it (admin sees everyone). Return null when
 *  allowed, or a RescheduleFailure to short-circuit. */
export type OwnershipCheck = (booking: Booking) => RescheduleFailure | null;

export async function rescheduleBookingCore(
  input: RescheduleInput,
  ownershipCheck?: OwnershipCheck,
): Promise<RescheduleResult> {
  let oldBooking: Booking;
  try {
    oldBooking = await getBooking(input.oldBookingId);
  } catch (err) {
    if (err instanceof SquareApiError && (err.status === 404 || err.code === 'NOT_FOUND')) {
      return {
        ok: false,
        status: 404,
        error: { code: 'NOT_FOUND', detail: 'Original booking not found.' },
      };
    }
    return {
      ok: false,
      status: 500,
      error: { code: 'INTERNAL', detail: 'Could not load original booking.' },
    };
  }

  if (ownershipCheck) {
    const denial = ownershipCheck(oldBooking);
    if (denial) return denial;
  }

  const segment = oldBooking.appointment_segments?.[0];
  if (!segment) {
    return {
      ok: false,
      status: 500,
      error: { code: 'INTERNAL', detail: 'Booking has no service segment.' },
    };
  }
  if (!oldBooking.customer_id) {
    return {
      ok: false,
      status: 500,
      error: { code: 'INTERNAL', detail: 'Booking has no customer.' },
    };
  }

  const teamMemberId = input.teamMemberId?.trim() || segment.team_member_id;

  const newBookingIdemKey = `mc-${input.actorPrefix}-resched-${createHash('sha256')
    .update(`${input.oldBookingId}|${input.newStartAtUtc}|${teamMemberId}`)
    .digest('hex')}`;

  let newBookingId: string;
  let newBookingVersion: number;
  try {
    const newBooking = await createBooking({
      startAtUtc: input.newStartAtUtc,
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
  } catch (err) {
    if (err instanceof SquareApiError) {
      const slotTaken =
        err.code === 'BOOKING_CONFLICT' ||
        err.code === 'TIME_CONFLICT' ||
        err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
        /already.*book|conflict|not available|overlap/i.test(`${err.code} ${err.detail}`);
      const status = slotTaken ? 409 : err.status >= 400 && err.status < 600 ? err.status : 502;
      return {
        ok: false,
        status,
        error: {
          code: err.code,
          detail: slotTaken
            ? 'That slot was just taken — please pick another.'
            : err.detail || 'Could not create the new booking.',
          slotTaken,
        },
      };
    }
    return {
      ok: false,
      status: 500,
      error: { code: 'INTERNAL', detail: 'Could not create new booking.' },
    };
  }

  const cancelIdemKey = `mc-${input.actorPrefix}-resched-cancel-${createHash('sha256')
    .update(`${oldBooking.id}|${oldBooking.version}|${newBookingId}`)
    .digest('hex')}`;
  try {
    await cancelBooking({
      bookingId: oldBooking.id,
      bookingVersion: oldBooking.version,
      idempotencyKey: cancelIdemKey,
    });
    return {
      ok: true,
      newBookingId,
      newBookingVersion,
      oldBookingId: oldBooking.id,
    };
  } catch {
    return {
      ok: true,
      newBookingId,
      newBookingVersion,
      oldBookingId: oldBooking.id,
      warning:
        'New appointment booked, but the old one could not be cancelled automatically — cancel it manually.',
    };
  }
}
