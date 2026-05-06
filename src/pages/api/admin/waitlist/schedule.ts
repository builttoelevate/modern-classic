// Phase 9 — admin one-tap "Book this slot" from /admin/waitlist.
//
// Resolves the waitlist entry's customer to a Square customer record by
// email, looks up the service variation's current `version` from the
// catalog (Square requires it on POST /v2/bookings), creates the booking
// under that customer with a deterministic idempotency key, then flips
// the waitlist entry's status to 'booked'.
//
// Square fires its own appointment-confirmation email automatically when
// a booking is created via the API, so we don't send anything ourselves
// here. The Resend "an opening just appeared" template is on the sister
// notify endpoint, not this one.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getWaitlistEntry,
  updateWaitlistStatus,
} from '../../../../lib/marketing/waitlistLog';
import { findCustomerByEmail } from '../../../../lib/square/customers';
import { getServices } from '../../../../lib/square/catalog';
import { createBooking } from '../../../../lib/square/bookings';
import { bookingIdempotencyKey } from '../../../../lib/booking/idempotency';
import { SquareApiError } from '../../../../lib/square/client';
import { redactEmail } from '../../../../lib/booking/log';

export const prerender = false;

interface ScheduleBody {
  entryId: string;
  startAtUtc: string;
  serviceVariationId: string;
  teamMemberId: string;
  durationMinutes: number;
}

function fail(code: string, detail: string, status: number): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function validate(body: unknown): ScheduleBody | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object.';
  const b = body as Record<string, unknown>;
  const entryId = typeof b.entryId === 'string' ? b.entryId.trim() : '';
  const startAtUtc = typeof b.startAtUtc === 'string' ? b.startAtUtc.trim() : '';
  const serviceVariationId =
    typeof b.serviceVariationId === 'string' ? b.serviceVariationId.trim() : '';
  const teamMemberId = typeof b.teamMemberId === 'string' ? b.teamMemberId.trim() : '';
  const durationMinutes =
    typeof b.durationMinutes === 'number' && Number.isFinite(b.durationMinutes)
      ? Math.floor(b.durationMinutes)
      : 0;

  if (!entryId) return 'entryId is required.';
  if (!startAtUtc) return 'startAtUtc is required.';
  if (Number.isNaN(Date.parse(startAtUtc))) return 'startAtUtc must be a valid ISO date.';
  if (!serviceVariationId) return 'serviceVariationId is required.';
  if (!teamMemberId) return 'teamMemberId is required.';
  if (durationMinutes <= 0) return 'durationMinutes must be > 0.';

  return { entryId, startAtUtc, serviceVariationId, teamMemberId, durationMinutes };
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('BAD_REQUEST', 'Body must be valid JSON.', 400);
  }
  const v = validate(raw);
  if (typeof v === 'string') return fail('BAD_REQUEST', v, 400);
  const { entryId, startAtUtc, serviceVariationId, teamMemberId, durationMinutes } = v;

  let entry;
  try {
    entry = await getWaitlistEntry(entryId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({ phase: 'waitlist-schedule-lookup-failed', entryId, detail });
    return fail('INTERNAL', detail, 500);
  }
  if (!entry) return fail('NOT_FOUND', 'No waitlist entry with that id.', 404);

  // Defensive — guard against the admin page being out of date when the
  // owner clicks. The variation/barber the UI sent has to match what's
  // on the entry.
  if (entry.serviceVariationId && entry.serviceVariationId !== serviceVariationId) {
    return fail(
      'BAD_REQUEST',
      'Service variation does not match this waitlist entry.',
      400,
    );
  }
  if (!entry.customerEmail || !entry.customerEmail.trim()) {
    return fail('NO_EMAIL', 'This waitlist entry has no email on file.', 400);
  }

  let customer;
  try {
    customer = await findCustomerByEmail(entry.customerEmail);
  } catch (err) {
    if (err instanceof SquareApiError) {
      logAdmin({
        phase: 'waitlist-schedule-customer-lookup-failed',
        entryId,
        email: redactEmail(entry.customerEmail),
        code: err.code,
        detail: err.detail,
      });
      return fail('SQUARE_ERROR', `${err.code}: ${err.detail}`, 502);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail('INTERNAL', detail, 500);
  }
  if (!customer) {
    return fail(
      'NO_CUSTOMER',
      'No Square customer matches this email — open Schedule them and book manually.',
      404,
    );
  }

  // Look up the variation's current version from the catalog. Square
  // requires `service_variation_version` on POST /v2/bookings to detect
  // stale clients. The waitlist form only persisted the variation id.
  let serviceVariationVersion: number | null = null;
  try {
    const services = await getServices();
    for (const s of services) {
      const v = s.variations.find((vv) => vv.id === serviceVariationId);
      if (v) {
        serviceVariationVersion = v.version;
        break;
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({ phase: 'waitlist-schedule-catalog-failed', entryId, detail });
    return fail('SQUARE_ERROR', detail, 502);
  }
  if (serviceVariationVersion === null) {
    return fail(
      'SERVICE_VARIATION_GONE',
      'That service no longer exists in the Square catalog.',
      422,
    );
  }

  const idempotencyKey = bookingIdempotencyKey({
    email: entry.customerEmail,
    startAtUtc,
    serviceVariationId,
  });

  let bookingId: string;
  try {
    const booking = await createBooking({
      startAtUtc,
      customerId: customer.id,
      serviceVariationId,
      serviceVariationVersion,
      teamMemberId,
      durationMinutes,
      customerNote: 'Booked from waitlist by admin.',
      idempotencyKey,
    });
    bookingId = booking.id;
  } catch (err) {
    if (err instanceof SquareApiError) {
      const msg = `${err.code} ${err.detail}`.toLowerCase();
      const slotTaken =
        err.status === 409 ||
        err.code === 'BOOKING_CONFLICT' ||
        err.code === 'TIME_CONFLICT' ||
        err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
        /already.*book|conflict|not available|overlap/.test(msg);
      logAdmin({
        phase: 'waitlist-schedule-square-error',
        entryId,
        email: redactEmail(entry.customerEmail),
        startAtUtc,
        code: err.code,
        detail: err.detail,
      });
      if (slotTaken) {
        return fail(
          'SLOT_TAKEN',
          'That slot was just taken — refreshing suggestions.',
          409,
        );
      }
      return fail('SQUARE_ERROR', `${err.code}: ${err.detail}`, 502);
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({ phase: 'waitlist-schedule-failed', entryId, detail });
    return fail('INTERNAL', detail, 500);
  }

  // Booking succeeded. Flip the entry to 'booked' so it drops out of
  // the active list and the cron stops considering it.
  try {
    await updateWaitlistStatus({
      id: entryId,
      status: 'booked',
      adminNote: `Booked ${startAtUtc} from admin.`,
    });
  } catch (err) {
    // Booking is already in Square — don't fail the request just
    // because the KV write hiccupped. Surface in logs for follow-up.
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({
      phase: 'waitlist-schedule-status-write-failed',
      entryId,
      bookingId,
      detail,
    });
  }

  logAdmin({
    phase: 'waitlist-schedule-booked',
    entryId,
    email: redactEmail(entry.customerEmail),
    bookingId,
    startAtUtc,
  });
  return Response.json({ ok: true, bookingId });
};
