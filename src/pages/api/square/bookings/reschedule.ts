import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { AuthRequiredError, requireSession, refreshSessionCookie } from '../../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../../lib/auth/session';
import { SquareApiError } from '../../../../lib/square/client';
import { cancelBooking, createBooking, getBooking } from '../../../../lib/square/bookings';
import { getCustomerById } from '../../../../lib/square/customers';
import { listLinkedPeople } from '../../../../lib/customer/profileLinks';
import {
  CustomerBlockedError,
  assertPhoneNotBlocked,
  blockedBookingPublicResponse,
} from '../../../../lib/customer/blockedCustomers';
import { redactEmail } from '../../../../lib/booking/log';

export const prerender = false;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface ReschedulePayload {
  oldBookingId: string;
  newSlot: { startAtUtc: string };
  service: { variationId: string; version: number; durationMinutes: number };
  barber: { id: string };
  customerNote?: string;
}

function isValidPayload(p: unknown): p is ReschedulePayload {
  if (!p || typeof p !== 'object') return false;
  const r = p as Partial<ReschedulePayload>;
  if (typeof r.oldBookingId !== 'string' || !r.oldBookingId) return false;
  if (!r.newSlot || typeof r.newSlot.startAtUtc !== 'string') return false;
  if (isNaN(new Date(r.newSlot.startAtUtc).getTime())) return false;
  if (!r.service || typeof r.service.variationId !== 'string') return false;
  if (typeof r.service.version !== 'number') return false;
  if (typeof r.service.durationMinutes !== 'number') return false;
  if (!r.barber || typeof r.barber.id !== 'string') return false;
  if (r.customerNote !== undefined && typeof r.customerNote !== 'string') return false;
  return true;
}

function logAction(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BOOK] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
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
  const payload: ReschedulePayload = body;

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
    logAction({ phase: 'reschedule-fetch-failed', detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not load original booking.' } },
      { status: 500 },
    );
  }

  // Ownership: signed-in customer OR one of their linked people
  // (kids / group members booked through the parent's profile).
  let allowed =
    !!oldBooking.customer_id && oldBooking.customer_id === session.customerId;
  if (!allowed && oldBooking.customer_id) {
    try {
      const linked = await listLinkedPeople(session.customerId);
      allowed = linked.some((p) => p.customerId === oldBooking.customer_id);
    } catch {
      // KV hiccup — refuse rather than leak rescheduling rights.
    }
  }
  if (!allowed) {
    logAction({
      phase: 'reschedule-forbidden',
      bookingId: payload.oldBookingId,
      sessionEmail: redactEmail(session.email),
    });
    return Response.json(
      { ok: false, error: { code: 'FORBIDDEN', detail: 'This booking does not belong to you.' } },
      { status: 403 },
    );
  }

  const oldStartMs = new Date(oldBooking.start_at).getTime();
  if (oldStartMs - Date.now() < TWENTY_FOUR_HOURS_MS) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'TOO_LATE_TO_RESCHEDULE',
          detail: 'Within 24 hours — please email modernclassicbarbershop@protonmail.com.',
        },
      },
      { status: 400 },
    );
  }

  // Idempotent on (customerId, oldBookingId, newStart). Re-submitting the
  // same reschedule produces the same Square booking instead of two.
  const newBookingIdemKey = `mc-resched-${createHash('sha256')
    .update(`${session.customerId}|${payload.oldBookingId}|${payload.newSlot.startAtUtc}`)
    .digest('hex')}`;

  // Use the ORIGINAL booking's customer_id when creating the
  // replacement, not session.customerId. Otherwise rescheduling a
  // linked-person's booking (kid / group member) would move it over
  // to the parent's customer record, breaking the per-person
  // grouping on /my-bookings + the booking-note tag. The ownership
  // check above already proved customer_id is set; the explicit
  // narrowing keeps TS happy.
  if (!oldBooking.customer_id) {
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Booking has no customer.' } },
      { status: 500 },
    );
  }
  const newCustomerId = oldBooking.customer_id;

  // Block-from-booking enforcement (public path). Fetch the resolved
  // customer's stored phone and check it before we create the new
  // booking. Fail closed: if the phone is missing or the fetch errors,
  // refuse with the generic "call the shop" response — we can't
  // honestly answer "is this phone blocked?" without it, so we don't
  // pretend it isn't.
  const reschedCustomer = await getCustomerById(newCustomerId).catch(() => null);
  const reschedPhone = reschedCustomer?.phone_number?.trim();
  if (!reschedPhone) {
    return blockedBookingPublicResponse();
  }
  try {
    await assertPhoneNotBlocked(reschedPhone, {
      bookingContext: 'reschedule',
      customerName:
        `${reschedCustomer?.given_name ?? ''} ${reschedCustomer?.family_name ?? ''}`.trim() ||
        undefined,
      customerEmail: reschedCustomer?.email_address ?? undefined,
      serviceId: payload.service.variationId,
      barberId: payload.barber.id,
      selectedStartAt: payload.newSlot.startAtUtc,
      ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
  } catch (err) {
    if (err instanceof CustomerBlockedError) {
      return blockedBookingPublicResponse();
    }
    throw err;
  }

  // Step 1: create the new booking. If it fails, the old one is intact.
  let newBookingId: string;
  try {
    const newBooking = await createBooking({
      startAtUtc: payload.newSlot.startAtUtc,
      customerId: newCustomerId,
      serviceVariationId: payload.service.variationId,
      serviceVariationVersion: payload.service.version,
      teamMemberId: payload.barber.id,
      durationMinutes: payload.service.durationMinutes,
      customerNote: payload.customerNote,
      idempotencyKey: newBookingIdemKey,
    });
    newBookingId = newBooking.id;
    logAction({
      phase: 'reschedule-new-created',
      oldBookingId: payload.oldBookingId,
      newBookingId,
      sessionEmail: redactEmail(session.email),
    });
  } catch (err) {
    if (err instanceof SquareApiError) {
      logAction({
        phase: 'reschedule-create-failed',
        oldBookingId: payload.oldBookingId,
        code: err.code,
        detail: err.detail,
        sessionEmail: redactEmail(session.email),
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
    logAction({ phase: 'reschedule-create-error', detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not create new booking.' } },
      { status: 500 },
    );
  }

  // Step 2: cancel the old booking. If this fails, the customer has the
  // new booking but the old one lingers — log it and surface a friendly
  // warning so the shop can clean up.
  const cancelIdemKey = `mc-resched-cancel-${createHash('sha256')
    .update(`${oldBooking.id}|${oldBooking.version}|${newBookingId}`)
    .digest('hex')}`;
  try {
    await cancelBooking({
      bookingId: oldBooking.id,
      bookingVersion: oldBooking.version,
      idempotencyKey: cancelIdemKey,
    });
    logAction({
      phase: 'reschedule-old-cancelled',
      oldBookingId: oldBooking.id,
      newBookingId,
      sessionEmail: redactEmail(session.email),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        newBookingId,
        oldBookingId: oldBooking.id,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAction({
      phase: 'reschedule-cancel-failed',
      severity: 'manual-cleanup-needed',
      oldBookingId: oldBooking.id,
      newBookingId,
      detail,
      sessionEmail: redactEmail(session.email),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        newBookingId,
        oldBookingId: oldBooking.id,
        warning:
          'Old appointment may still appear briefly. We have notified the shop to clean it up.',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshSessionCookie(session),
        },
      },
    );
  }
};
