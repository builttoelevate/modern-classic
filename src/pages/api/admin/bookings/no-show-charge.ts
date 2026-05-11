import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { SquareApiError } from '../../../../lib/square/client';
import { getBooking, cancelBooking } from '../../../../lib/square/bookings';
import { chargeCardOnFile } from '../../../../lib/square/payments';
import {
  getBookingCardRecord,
  markBookingCharged,
  markBookingChargeFailed,
} from '../../../../lib/booking/cardIndex';
import { getCustomerById } from '../../../../lib/square/customers';
import { resolveBarberContact } from '../../../../lib/barber/contactLookup';
import { sendNoShowChargeBarber } from '../../../../lib/email/resend';

export const prerender = false;

const SHOP_TZ = 'America/New_York';
const SHOP_PHONE = '740-297-4462';

function formatWhenLabel(utc: string | undefined): string {
  if (!utc) return 'this appointment';
  const d = new Date(utc);
  if (isNaN(d.getTime())) return 'this appointment';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

// "Mark no-show & charge" — fired from /admin/bookings when Michael
// notices a customer didn't show. Strictly admin-gated (HTTP Basic Auth).
//
// Two side effects:
//   1. Cancel the Square booking (booking_status = CANCELLED_BY_SELLER —
//      Square's Bookings API does NOT expose a direct "set status to
//      NO_SHOW" mutation outside the appointments app, so we cancel
//      with a clear note and rely on the KV index to record that the
//      cancellation reason was "no-show + charged").
//   2. Charge the saved card on file for the booking's full service
//      price.
//
// If the charge fails, we still consider the booking handled (the slot
// is over) — we just mark the index entry as 'failed' so the row stays
// visible in admin with the failure reason.

interface SuccessResponse {
  ok: true;
  bookingId: string;
  paymentId?: string;
  amountCents: number;
  /** True when the Square booking was cancelled in this call; false if
   *  it was already in a cancelled / no-show state. */
  cancelled: boolean;
  /** When the charge failed but the cancellation succeeded. */
  chargeFailed?: { detail: string };
}

interface FailureResponse {
  ok: false;
  error: { code: string; detail: string };
}

function fail(status: number, code: string, detail: string): Response {
  const body: FailureResponse = { ok: false, error: { code, detail } };
  return Response.json(body, { status });
}

function logAction(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let bookingId: string;
  try {
    const body = (await request.json()) as { bookingId?: string };
    bookingId = (body.bookingId ?? '').trim();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  if (!bookingId) return fail(400, 'BAD_REQUEST', 'bookingId is required.');

  // Pull the booking + card record in parallel — both are required
  // before we touch Square. If the card record is missing, this is a
  // returning customer (no card on file) and the admin shouldn't see
  // the button at all; refuse defensively.
  const [bookingResult, cardRecord] = await Promise.allSettled([
    getBooking(bookingId),
    getBookingCardRecord(bookingId),
  ]);

  if (bookingResult.status === 'rejected') {
    const err = bookingResult.reason;
    if (err instanceof SquareApiError && err.status === 404) {
      return fail(404, 'NOT_FOUND', 'Booking not found.');
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'no-show-fetch-failed', bookingId, detail });
    return fail(500, 'INTERNAL', 'Could not load booking.');
  }
  const booking = bookingResult.value;

  const card =
    cardRecord.status === 'fulfilled' && cardRecord.value ? cardRecord.value : null;
  if (!card) {
    return fail(
      400,
      'NO_CARD_ON_FILE',
      'This booking has no card on file. Cancel manually in Square or call the customer.',
    );
  }
  if (card.chargeStatus !== 'pending' && card.chargeStatus !== 'failed') {
    return fail(
      409,
      'ALREADY_CHARGED',
      `Already charged (${card.chargeStatus}). Refunds must be issued from Square.`,
    );
  }

  // Defensive: never let a misclick on a stale tab — or any non-UI
  // caller — charge a customer for a no-show on an appointment that
  // hasn't happened yet. The admin UI gates the button via
  // canChargeNoShow(), but the API has to enforce it independently.
  if (booking.start_at && new Date(booking.start_at).getTime() >= Date.now()) {
    return fail(
      400,
      'APPOINTMENT_NOT_PAST',
      'This appointment has not started yet. You can only mark a customer no-show after the appointment time has passed.',
    );
  }

  // Cancel the Square booking first. If it's already in a cancelled
  // state we skip — but we still proceed with the charge (a customer
  // who cancelled-late then was marked no-show is still a no-show).
  let cancelled = false;
  const TERMINAL = new Set([
    'CANCELLED_BY_CUSTOMER',
    'CANCELLED_BY_SELLER',
    'NO_SHOW',
    'DECLINED',
  ]);
  if (!TERMINAL.has(booking.status)) {
    try {
      const idempotencyKey = `mc-noshow-cancel-${createHash('sha256')
        .update(`${booking.id}|${booking.version}`)
        .digest('hex')
        .slice(0, 40)}`;
      await cancelBooking({
        bookingId: booking.id,
        bookingVersion: booking.version,
        idempotencyKey,
      });
      cancelled = true;
    } catch (err) {
      const detail =
        err instanceof SquareApiError
          ? `${err.code}: ${err.detail}`
          : err instanceof Error
            ? err.message
            : String(err);
      logAction({ phase: 'no-show-cancel-failed', bookingId, detail });
      // Don't bail — we can still charge a no-show whose Square record
      // can't be re-cancelled (it might already be terminal under our
      // feet). Surface the issue but continue.
    }
  }

  try {
    // Shared idempotency prefix with the customer-facing late-cancel
    // endpoint so Square dedupes the rare TOCTOU race where both fire
    // at once. See cancel.ts for the matching comment.
    const payment = await chargeCardOnFile({
      customerId: card.squareCustomerId,
      cardId: card.squareCardId,
      amountCents: card.servicePriceCents,
      idempotencyKey: `mc-charge-${booking.id}`,
      note: `No-show charge — booking ${booking.id}, ${card.serviceName}`,
    });
    await markBookingCharged({
      bookingId: booking.id,
      chargeStatus: 'no-show',
      chargedPaymentId: payment.id,
    });
    logAction({
      phase: 'no-show-charge-success',
      bookingId,
      paymentId: payment.id,
      amountCents: card.servicePriceCents,
    });

    // Barber notification — let the assigned barber know their slot
    // was lost AND the shop already charged. Non-fatal; the charge has
    // already landed by this point. We do a separate getCustomerById
    // for the customer's display name since the booking row only has
    // the customer_id.
    void notifyBarberOfNoShowCharge({
      teamMemberId: booking.appointment_segments?.[0]?.team_member_id,
      customerId: booking.customer_id,
      serviceName: card.serviceName,
      whenLabelUtc: booking.start_at,
      amountCents: card.servicePriceCents,
    });

    const success: SuccessResponse = {
      ok: true,
      bookingId,
      paymentId: payment.id,
      amountCents: card.servicePriceCents,
      cancelled,
    };
    return Response.json(success, { status: 200 });
  } catch (err) {
    const detail =
      err instanceof SquareApiError
        ? `${err.code}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : String(err);
    try {
      await markBookingChargeFailed(booking.id, detail);
    } catch {
      // ignore secondary KV failure; the audit log line below is the
      // canonical record of what we attempted.
    }
    logAction({ phase: 'no-show-charge-failed', bookingId, detail });
    const success: SuccessResponse = {
      ok: true,
      bookingId,
      amountCents: card.servicePriceCents,
      cancelled,
      chargeFailed: { detail },
    };
    return Response.json(success, { status: 200 });
  }
};

// Fire-and-forget barber notification. Pulled out into a helper so we
// can call it with `void` and never block the success response on
// email delivery. Any failure is logged but never thrown.
async function notifyBarberOfNoShowCharge(input: {
  teamMemberId: string | undefined;
  customerId: string | undefined;
  serviceName: string;
  whenLabelUtc: string | undefined;
  amountCents: number;
}): Promise<void> {
  try {
    if (!input.teamMemberId) {
      logAction({ phase: 'no-show-barber-notify-skipped-no-team-member' });
      return;
    }
    const [contact, customer] = await Promise.all([
      resolveBarberContact(input.teamMemberId),
      input.customerId ? getCustomerById(input.customerId).catch(() => null) : Promise.resolve(null),
    ]);
    if (!contact) {
      logAction({
        phase: 'no-show-barber-notify-skipped-no-email',
        teamMemberId: input.teamMemberId,
      });
      return;
    }
    const customerName = customer
      ? `${customer.given_name ?? ''} ${customer.family_name ?? ''}`.trim() || 'the customer'
      : 'the customer';
    const send = await sendNoShowChargeBarber({
      to: contact.email,
      barberDisplayName: contact.displayName,
      customerName,
      serviceName: input.serviceName,
      whenLabel: formatWhenLabel(input.whenLabelUtc),
      amountCents: input.amountCents,
      shopPhone: SHOP_PHONE,
    });
    logAction({
      phase: 'no-show-barber-notify-sent',
      teamMemberId: input.teamMemberId,
      resendId: send.id,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAction({
      phase: 'no-show-barber-notify-failed',
      teamMemberId: input.teamMemberId,
      detail,
    });
  }
}
