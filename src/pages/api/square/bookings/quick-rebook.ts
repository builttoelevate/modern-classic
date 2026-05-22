// Phase 6 Part B — one-tap rebook endpoint.
//
// Validates the slot is still available, then calls Phase 3's createBooking
// with a deterministic idempotency key so a double-tap doesn't create two.

import type { APIRoute } from 'astro';
import { AuthRequiredError, requireSession, refreshSessionCookie } from '../../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../../lib/auth/session';
import { SquareApiError } from '../../../../lib/square/client';
import { searchAvailability } from '../../../../lib/square/availability';
import { composeSellerNote, createBooking } from '../../../../lib/square/bookings';
import { getCustomerById } from '../../../../lib/square/customers';
import {
  CustomerBlockedError,
  assertPhoneNotBlocked,
  blockedBookingPublicResponse,
} from '../../../../lib/customer/blockedCustomers';
import { bookingIdempotencyKey } from '../../../../lib/booking/idempotency';
import { redactEmail } from '../../../../lib/booking/log';

export const prerender = false;

interface QuickRebookPayload {
  serviceVariationId: string;
  serviceVariationVersion: number;
  teamMemberId: string;
  durationMinutes: number;
  startAtUtc: string;
}

function isValid(p: unknown): p is QuickRebookPayload {
  if (!p || typeof p !== 'object') return false;
  const r = p as Partial<QuickRebookPayload>;
  if (typeof r.serviceVariationId !== 'string' || !r.serviceVariationId) return false;
  if (typeof r.serviceVariationVersion !== 'number') return false;
  if (typeof r.teamMemberId !== 'string' || !r.teamMemberId) return false;
  if (typeof r.durationMinutes !== 'number' || r.durationMinutes <= 0) return false;
  if (typeof r.startAtUtc !== 'string' || !r.startAtUtc) return false;
  if (isNaN(new Date(r.startAtUtc).getTime())) return false;
  return true;
}

function logAction(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BOOK] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

const SLOT_VALIDATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour around target

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
  if (!isValid(body)) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Missing required fields.' } },
      { status: 400 },
    );
  }

  const targetMs = new Date(body.startAtUtc).getTime();
  if (targetMs <= Date.now()) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Slot is in the past.' } },
      { status: 400 },
    );
  }

  // 1) Re-check availability around the target slot. The cache that
  // produced the original 3 slots is up to 10 minutes stale; this call
  // is uncached and authoritative.
  try {
    const slots = await searchAvailability({
      serviceVariationId: body.serviceVariationId,
      teamMemberId: body.teamMemberId,
      startAt: new Date(targetMs - SLOT_VALIDATION_WINDOW_MS),
      endAt: new Date(targetMs + SLOT_VALIDATION_WINDOW_MS),
    });
    const stillAvailable = slots.some((s) => s.startAtUtc === body.startAtUtc);
    if (!stillAvailable) {
      logAction({
        phase: 'quick-rebook-slot-taken',
        sessionEmail: redactEmail(session.email),
        startAtUtc: body.startAtUtc,
      });
      return Response.json(
        {
          ok: false,
          error: {
            code: 'SLOT_TAKEN',
            detail: 'That time was just taken — pick another.',
          },
        },
        { status: 409 },
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAction({
      phase: 'quick-rebook-availability-failed',
      detail,
      sessionEmail: redactEmail(session.email),
    });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not validate availability.' } },
      { status: 502 },
    );
  }

  // 2) Block-from-booking enforcement (public path). Fetch the
  // session customer's stored phone and check it. Fail closed: if the
  // phone is missing or the fetch errors, refuse with the generic
  // response rather than letting an unverified state through.
  const rebookCustomer = await getCustomerById(session.customerId).catch(() => null);
  const rebookPhone = rebookCustomer?.phone_number?.trim();
  if (!rebookPhone) {
    return blockedBookingPublicResponse();
  }
  try {
    await assertPhoneNotBlocked(rebookPhone, {
      bookingContext: 'quick-rebook',
      customerName:
        `${rebookCustomer?.given_name ?? ''} ${rebookCustomer?.family_name ?? ''}`.trim() ||
        undefined,
      customerEmail: rebookCustomer?.email_address ?? session.email,
      serviceId: body.serviceVariationId,
      barberId: body.teamMemberId,
      selectedStartAt: body.startAtUtc,
      ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
  } catch (err) {
    if (err instanceof CustomerBlockedError) {
      return blockedBookingPublicResponse();
    }
    throw err;
  }

  // 3) Create the booking via Phase 3's wrapper, with a deterministic key.
  const idempotencyKey = bookingIdempotencyKey({
    email: session.email,
    startAtUtc: body.startAtUtc,
    serviceVariationId: body.serviceVariationId,
  });

  try {
    const booking = await createBooking({
      startAtUtc: body.startAtUtc,
      customerId: session.customerId,
      serviceVariationId: body.serviceVariationId,
      serviceVariationVersion: body.serviceVariationVersion,
      teamMemberId: body.teamMemberId,
      durationMinutes: body.durationMinutes,
      sellerNote: composeSellerNote(
        'Booked',
        rebookCustomer?.given_name,
        rebookCustomer?.family_name,
      ),
      idempotencyKey,
    });
    logAction({
      phase: 'quick-rebook-success',
      bookingId: booking.id,
      startAtUtc: booking.start_at,
      sessionEmail: redactEmail(session.email),
    });
    return new Response(
      JSON.stringify({ ok: true, bookingId: booking.id, startAtUtc: booking.start_at }),
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
        phase: 'quick-rebook-square-error',
        code: err.code,
        detail: err.detail,
        sessionEmail: redactEmail(session.email),
      });
      const slotTaken =
        err.code === 'BOOKING_CONFLICT' ||
        err.code === 'TIME_CONFLICT' ||
        err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
        /already.*book|conflict|not available|overlap/i.test(`${err.code} ${err.detail}`);
      if (slotTaken) {
        return Response.json(
          {
            ok: false,
            error: {
              code: 'SLOT_TAKEN',
              detail: 'That time was just taken — pick another.',
            },
          },
          { status: 409 },
        );
      }
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail || 'Square rejected the booking.' } },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'quick-rebook-failed', detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not complete booking.' } },
      { status: 500 },
    );
  }
};
