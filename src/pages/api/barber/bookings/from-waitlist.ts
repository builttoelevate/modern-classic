// POST /api/barber/bookings/from-waitlist — book a waitlist customer
// into one of the calling barber's open slots in a single tap.
//
// Used by the /barber/dashboard "Schedule from waitlist" panel:
//   1. Barber sees Bill on their waitlist
//   2. Taps Schedule, picks an open slot in the inline panel
//   3. We resolve Bill's Square record (find-or-create), create the
//      booking under the barber's chair, and mark the waitlist
//      entry as 'booked' so it drops off the active list
//
// Auth: requireBarberSession. The booking is always created under
// session.barberId — a barber can never schedule a slot for
// someone else's chair via this endpoint.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import {
  getWaitlistEntry,
  updateWaitlistStatus,
} from '../../../../lib/marketing/waitlistLog';
import { findOrCreateCustomer } from '../../../../lib/square/customers';
import { createBooking } from '../../../../lib/square/bookings';
import { getServices } from '../../../../lib/square/catalog';
import { bookingIdempotencyKey } from '../../../../lib/booking/idempotency';
import { SquareApiError } from '../../../../lib/square/client';
import type { ServiceVariation } from '../../../../lib/square/types';

export const prerender = false;

function logBarber(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

function splitName(full: string): { givenName: string; familyName: string } {
  const trimmed = full.trim();
  if (!trimmed) return { givenName: '', familyName: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { givenName: parts[0], familyName: '' };
  return {
    givenName: parts[0],
    familyName: parts.slice(1).join(' '),
  };
}

/**
 * Locate the right ServiceVariation for the given waitlist entry +
 * calling barber. Preferred path: the entry already carries a
 * serviceVariationId from when the customer submitted (recent
 * entries). Fallback: match by serviceName + barber via the catalog
 * (legacy entries pre-PR 8). Returns null when no match is possible
 * — caller surfaces a friendly 422.
 */
async function resolveVariation(
  entryServiceVariationId: string | null,
  serviceName: string,
  barberId: string,
): Promise<ServiceVariation | null> {
  const services = await getServices().catch(() => []);
  if (entryServiceVariationId) {
    for (const s of services) {
      const v = s.variations.find((x) => x.id === entryServiceVariationId);
      if (v) return v;
    }
  }
  // Fallback: match by serviceName + eligible team member.
  const normalized = serviceName.trim().toLowerCase();
  for (const s of services) {
    if (s.name.trim().toLowerCase() !== normalized) continue;
    const v = s.variations.find(
      (x) => x.eligibleTeamMemberIds?.includes(barberId),
    );
    if (v) return v;
  }
  return null;
}

interface RequestBody {
  waitlistEntryId?: string;
  startAtUtc?: string;
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
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const b = (body ?? {}) as RequestBody;
  const waitlistEntryId =
    typeof b.waitlistEntryId === 'string' ? b.waitlistEntryId.trim() : '';
  const startAtUtc = typeof b.startAtUtc === 'string' ? b.startAtUtc.trim() : '';
  if (!waitlistEntryId) return fail(400, 'BAD_REQUEST', 'waitlistEntryId is required.');
  if (!startAtUtc) return fail(400, 'BAD_REQUEST', 'startAtUtc is required.');
  if (isNaN(new Date(startAtUtc).getTime())) {
    return fail(400, 'BAD_REQUEST', 'startAtUtc is not a valid ISO date.');
  }

  // Step 1 — read the waitlist entry.
  const entry = await getWaitlistEntry(waitlistEntryId).catch(() => null);
  if (!entry) return fail(404, 'WAITLIST_NOT_FOUND', 'That waitlist entry no longer exists.');

  // Step 2 — must still be active. 'booked' / 'archived' means
  // someone else (or the cron) already handled it.
  if (entry.status !== 'new' && entry.status !== 'contacted') {
    return fail(
      409,
      'WAITLIST_NOT_ACTIVE',
      `That waitlist entry is already ${entry.status}.`,
    );
  }

  // Step 3 — resolve the service variation under the calling barber.
  const variation = await resolveVariation(
    entry.serviceVariationId,
    entry.serviceName,
    session.barberId,
  );
  if (!variation) {
    logBarber({
      phase: 'schedule-from-waitlist-no-variation',
      waitlistEntryId,
      serviceName: entry.serviceName,
      barberId: session.barberId,
    });
    return fail(
      422,
      'SERVICE_NOT_RESOLVABLE',
      "Couldn't match the service on this waitlist entry to one you offer. Edit the entry's service in admin and try again.",
    );
  }

  // Step 4 — find-or-create the Square customer record from the
  // waitlist contact fields. Returning customers match by email
  // first then phone; no duplicate is created.
  const { givenName, familyName } = splitName(entry.customerName);
  let customerId: string;
  try {
    const result = await findOrCreateCustomer({
      givenName,
      familyName,
      email: entry.customerEmail,
      phone: entry.customerPhone,
      updateContact: false,
      marketingConsent: false,
      marketingConsentSource: 'barber_schedule_from_waitlist',
    });
    customerId = result.customer.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logBarber({
      phase: 'schedule-from-waitlist-customer-failed',
      waitlistEntryId,
      detail,
    });
    return fail(502, 'CUSTOMER_RESOLVE_FAILED', detail);
  }

  // Step 5 — create the booking. Idempotency key is deterministic
  // on (email, slot, variation), so a double-tap returns the same
  // booking instead of duplicating.
  let bookingId: string;
  try {
    const booking = await createBooking({
      startAtUtc,
      customerId,
      serviceVariationId: variation.id,
      serviceVariationVersion: variation.version,
      teamMemberId: session.barberId,
      durationMinutes: variation.durationMinutes,
      customerNote: entry.note?.trim() || undefined,
      idempotencyKey: bookingIdempotencyKey({
        email: entry.customerEmail,
        startAtUtc,
        serviceVariationId: variation.id,
      }),
    });
    bookingId = booking.id;
  } catch (err) {
    if (err instanceof SquareApiError) {
      const msg = `${err.code} ${err.detail}`.toLowerCase();
      const slotTaken =
        err.code === 'BOOKING_CONFLICT' ||
        err.code === 'TIME_CONFLICT' ||
        err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
        /already.*book|conflict|not available|overlap/.test(msg);
      logBarber({
        phase: 'schedule-from-waitlist-create-failed',
        waitlistEntryId,
        startAtUtc,
        squareCode: err.code,
        squareDetail: err.detail,
      });
      return fail(
        slotTaken ? 409 : err.status >= 400 && err.status < 600 ? err.status : 502,
        slotTaken ? 'SLOT_TAKEN' : err.code,
        slotTaken
          ? 'That slot was just taken — pick another.'
          : err.detail || 'Square returned an error.',
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logBarber({
      phase: 'schedule-from-waitlist-create-failed',
      waitlistEntryId,
      startAtUtc,
      detail,
    });
    return fail(502, 'CREATE_FAILED', detail);
  }

  // Step 6 — drop the entry off the active list. Best-effort — if
  // the write fails the booking still stands; the barber can
  // manually mark it booked from admin.
  try {
    await updateWaitlistStatus({
      id: waitlistEntryId,
      status: 'booked',
    });
  } catch (err) {
    logBarber({
      phase: 'schedule-from-waitlist-status-write-failed',
      waitlistEntryId,
      bookingId,
      detail: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal.
  }

  logBarber({
    phase: 'schedule-from-waitlist-success',
    waitlistEntryId,
    bookingId,
    customerId,
    barberId: session.barberId,
    startAtUtc,
  });

  return new Response(
    JSON.stringify({ ok: true, bookingId, customerId, waitlistEntryId }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshBarberSessionCookie(session),
      },
    },
  );
};
