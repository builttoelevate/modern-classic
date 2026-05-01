import type { APIRoute } from 'astro';
import { SquareApiError } from '../../../lib/square/client';
import { findOrCreateCustomer } from '../../../lib/square/customers';
import { createBooking } from '../../../lib/square/bookings';
import { bookingIdempotencyKey } from '../../../lib/booking/idempotency';
import { customerInitials, logBooking, redactEmail } from '../../../lib/booking/log';
import type {
  CreateBookingFailure,
  CreateBookingRequest,
  CreateBookingResponse,
  CreateBookingSuccess,
} from '../../../lib/booking/types';

export const prerender = false;

function fail(
  status: number,
  code: string,
  detail: string,
  extra?: Partial<CreateBookingFailure['error']>,
): Response {
  const body: CreateBookingFailure = {
    ok: false,
    error: { code, detail, ...(extra ?? {}) },
  };
  return Response.json(body satisfies CreateBookingResponse, { status });
}

function classifySquareError(err: SquareApiError): {
  status: number;
  code: string;
  detail: string;
  slotTaken?: boolean;
  leadTimeTooShort?: boolean;
} {
  // Rough classification — Square doesn't return a single canonical "slot
  // taken" code, but the patterns below cover the practical cases.
  const msg = `${err.code} ${err.detail}`.toLowerCase();
  if (
    err.code === 'BOOKING_CONFLICT' ||
    err.code === 'TIME_CONFLICT' ||
    err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
    /already.*book|conflict|not available|overlap/.test(msg)
  ) {
    return {
      status: 409,
      code: err.code,
      detail: 'That slot was just taken — please pick another.',
      slotTaken: true,
    };
  }
  if (
    err.code === 'INVALID_TIME' ||
    err.code === 'BOOKING_TIME_TOO_EARLY' ||
    /too soon|too early|lead time/.test(msg)
  ) {
    return {
      status: 422,
      code: err.code,
      detail: "Sorry, that's too soon — please pick a later time.",
      leadTimeTooShort: true,
    };
  }
  if (err.code === 'AUTHENTICATION_ERROR' || err.code === 'UNAUTHORIZED') {
    return {
      status: 502,
      code: err.code,
      detail: 'Booking system is temporarily unavailable.',
    };
  }
  return {
    status: err.status >= 400 && err.status < 600 ? err.status : 502,
    code: err.code,
    detail: err.detail || 'Square returned an error.',
  };
}

function validate(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'Payload must be an object';
  const r = p as Partial<CreateBookingRequest>;
  if (!r.service?.variationId) return 'service.variationId is required';
  if (typeof r.service?.version !== 'number') return 'service.version is required';
  if (typeof r.service?.durationMinutes !== 'number') return 'service.durationMinutes is required';
  if (!r.barber?.id) return 'barber.id is required';
  if (!r.slot?.startAtUtc) return 'slot.startAtUtc is required';
  if (isNaN(new Date(r.slot.startAtUtc).getTime())) return 'slot.startAtUtc must be a valid ISO date';
  if (!r.customer?.givenName?.trim()) return 'customer.givenName is required';
  if (!r.customer?.familyName?.trim()) return 'customer.familyName is required';
  if (!r.customer?.email?.trim()) return 'customer.email is required';
  if (!/^\S+@\S+\.\S+$/.test(r.customer.email.trim())) return 'customer.email is not a valid email';
  if (!r.customer?.phone) return 'customer.phone is required';
  if (r.customer.phone.replace(/\D/g, '').length < 10) return 'customer.phone must be 10 digits';
  if (r.customer.note && r.customer.note.length > 500) return 'customer.note exceeds 500 chars';
  return null;
}

export const POST: APIRoute = async ({ request }) => {
  const startedAt = Date.now();
  let attemptId = 'unknown';
  if (typeof crypto?.randomUUID === 'function') {
    attemptId = crypto.randomUUID();
  } else {
    attemptId = `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  let payload: CreateBookingRequest;
  try {
    payload = (await request.json()) as CreateBookingRequest;
  } catch {
    logBooking({ phase: 'validation-failed', attemptId, errorDetail: 'invalid JSON' });
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON');
  }

  const validationErr = validate(payload);
  if (validationErr) {
    logBooking({
      phase: 'validation-failed',
      attemptId,
      customerEmail: redactEmail(payload?.customer?.email),
      errorDetail: validationErr,
    });
    return fail(400, 'BAD_REQUEST', validationErr);
  }

  const initials = customerInitials(payload.customer.givenName, payload.customer.familyName);
  logBooking({
    phase: 'request-received',
    attemptId,
    customerEmail: redactEmail(payload.customer.email),
    customerInitials: initials,
    service: payload.service.name,
    startAtUtc: payload.slot.startAtUtc,
  });

  const idempotencyKey = bookingIdempotencyKey({
    email: payload.customer.email,
    startAtUtc: payload.slot.startAtUtc,
    serviceVariationId: payload.service.variationId,
  });

  try {
    const findOrCreate = await findOrCreateCustomer({
      givenName: payload.customer.givenName.trim(),
      familyName: payload.customer.familyName.trim(),
      email: payload.customer.email.trim().toLowerCase(),
      phone: payload.customer.phone,
      updateContact: payload.customer.updateContact ?? false,
      marketingConsent: payload.customer.marketingConsent === true,
      marketingConsentSource: 'booking_flow_step_4',
    });

    logBooking({
      phase: 'find-or-create-customer',
      attemptId,
      customerEmail: redactEmail(payload.customer.email),
      customerInitials: initials,
      customerId: findOrCreate.customer.id,
      marketingConsent: payload.customer.marketingConsent === true,
      marketingDecision: findOrCreate.marketingDecision.kind,
    });

    const booking = await createBooking({
      startAtUtc: payload.slot.startAtUtc,
      customerId: findOrCreate.customer.id,
      serviceVariationId: payload.service.variationId,
      serviceVariationVersion: payload.service.version,
      teamMemberId: payload.barber.id,
      durationMinutes: payload.service.durationMinutes,
      customerNote: payload.customer.note,
      idempotencyKey,
    });

    logBooking({
      phase: 'success',
      attemptId,
      customerEmail: redactEmail(payload.customer.email),
      customerInitials: initials,
      service: payload.service.name,
      startAtUtc: booking.start_at,
      bookingId: booking.id,
      customerId: findOrCreate.customer.id,
      durationMs: Date.now() - startedAt,
    });

    const success: CreateBookingSuccess = {
      ok: true,
      bookingId: booking.id,
      customerId: findOrCreate.customer.id,
      startAtUtc: booking.start_at,
    };
    return Response.json(success satisfies CreateBookingResponse, { status: 200 });
  } catch (err) {
    if (err instanceof SquareApiError) {
      const cls = classifySquareError(err);
      logBooking({
        phase: 'square-error',
        attemptId,
        customerEmail: redactEmail(payload.customer.email),
        service: payload.service.name,
        startAtUtc: payload.slot.startAtUtc,
        errorCode: cls.code,
        errorDetail: cls.detail,
        durationMs: Date.now() - startedAt,
      });
      return fail(cls.status, cls.code, cls.detail, {
        slotTaken: cls.slotTaken,
        leadTimeTooShort: cls.leadTimeTooShort,
      });
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logBooking({
      phase: 'unexpected-error',
      attemptId,
      customerEmail: redactEmail(payload.customer.email),
      errorDetail: detail,
      durationMs: Date.now() - startedAt,
    });
    return fail(500, 'INTERNAL', 'Something went wrong on our side. Please try again.');
  }
};
