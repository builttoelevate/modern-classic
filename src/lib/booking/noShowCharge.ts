// Shared no-show charge logic. Lifted from
// src/pages/api/admin/bookings/no-show-charge.ts so both the admin
// endpoint (Basic Auth) and the barber-side endpoint (session + owner
// role) can run the same cancel-then-charge sequence with identical
// behavior. The auth gate is the route's responsibility; this module
// is auth-agnostic.
//
// Two side effects on a successful call:
//   1. Cancel the Square booking (booking_status = CANCELLED_BY_SELLER —
//      Square's Bookings API does NOT expose a direct "set status to
//      NO_SHOW" mutation outside the appointments app, so we cancel
//      with the saved-card index recording the "no-show + charged"
//      audit trail).
//   2. Charge the saved card on file for the full service price.
//
// If the charge fails, the booking still ends up handled — the slot
// is over either way; we just flip the index entry to 'failed' so
// the row stays visible and retryable.

import { createHash } from 'node:crypto';
import { SquareApiError } from '../square/client';
import { getBooking, cancelBooking } from '../square/bookings';
import { chargeCardOnFile } from '../square/payments';
import { getCustomerById } from '../square/customers';
import { resolveBarberContact } from '../barber/contactLookup';
import { sendNoShowChargeBarber } from '../email/resend';
import { SHOP_PHONE } from '../branding';
import {
  getBookingCardRecord,
  markBookingCharged,
  markBookingChargeFailed,
  type BookingCardRecord,
} from './cardIndex';
import type { Booking } from '../square/types';

const SHOP_TZ = 'America/New_York';

/** True iff this booking is in a chargeable state right now: in the
 *  past, has a card-on-file record, and that record isn't already
 *  marked charged. The UI uses this to render the button; the helper
 *  below re-validates these conditions server-side. */
export function canChargeNoShow(b: Booking, record: BookingCardRecord | null): boolean {
  if (!record) return false;
  if (record.chargeStatus !== 'pending' && record.chargeStatus !== 'failed') return false;
  if (!b.start_at) return false;
  return new Date(b.start_at).getTime() < Date.now();
}

export interface NoShowChargeSuccess {
  ok: true;
  bookingId: string;
  paymentId?: string;
  amountCents: number;
  /** True when the Square booking was cancelled in this call; false if it
   *  was already in a cancelled / no-show state when we found it. */
  cancelled: boolean;
  /** Present iff the cancellation succeeded but the charge failed (e.g.
   *  card declined). The booking is still considered handled; the index
   *  entry is flipped to 'failed' so it can be retried. */
  chargeFailed?: { detail: string };
}

/** Typed guard errors thrown by chargeNoShowBooking. Each route maps
 *  these to its own HTTP status; the helper itself stays HTTP-agnostic. */
export class NoShowChargeError extends Error {
  readonly code:
    | 'BOOKING_NOT_FOUND'
    | 'NO_CARD_ON_FILE'
    | 'ALREADY_CHARGED'
    | 'APPOINTMENT_NOT_PAST'
    | 'FETCH_FAILED';
  readonly detail: string;
  constructor(code: NoShowChargeError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'NoShowChargeError';
    this.code = code;
    this.detail = detail;
  }
}

/** Cancel-then-charge for a no-show. Idempotent across retries via
 *  Square idempotency keys; safe to invoke twice.
 *
 *  Throws NoShowChargeError for guard failures (booking missing, no
 *  card on file, already charged, appointment not yet past). Returns
 *  NoShowChargeSuccess on success — including the "charge declined"
 *  case (`chargeFailed` populated), which is still a success from the
 *  caller's perspective because the cancel succeeded and the index
 *  entry is now retryable. */
export async function chargeNoShowBooking(bookingId: string): Promise<NoShowChargeSuccess> {
  const trimmed = (bookingId ?? '').trim();
  if (!trimmed) {
    throw new NoShowChargeError('BOOKING_NOT_FOUND', 'bookingId is required.');
  }

  const [bookingResult, cardResult] = await Promise.allSettled([
    getBooking(trimmed),
    getBookingCardRecord(trimmed),
  ]);

  if (bookingResult.status === 'rejected') {
    const err = bookingResult.reason;
    if (err instanceof SquareApiError && err.status === 404) {
      throw new NoShowChargeError('BOOKING_NOT_FOUND', 'Booking not found.');
    }
    const detail = err instanceof Error ? err.message : String(err);
    log({ phase: 'no-show-fetch-failed', bookingId: trimmed, detail });
    throw new NoShowChargeError('FETCH_FAILED', 'Could not load booking.');
  }
  const booking = bookingResult.value;

  const card = cardResult.status === 'fulfilled' && cardResult.value ? cardResult.value : null;
  if (!card) {
    throw new NoShowChargeError(
      'NO_CARD_ON_FILE',
      'This booking has no card on file. Cancel manually in Square or call the customer.',
    );
  }
  if (card.chargeStatus !== 'pending' && card.chargeStatus !== 'failed') {
    throw new NoShowChargeError(
      'ALREADY_CHARGED',
      `Already charged (${card.chargeStatus}). Refunds must be issued from Square.`,
    );
  }

  // Defensive: never let a misclick on a stale tab — or any non-UI
  // caller — charge a customer for a no-show on an appointment that
  // hasn't happened yet. The UI gates via canChargeNoShow, but the
  // helper enforces independently.
  if (booking.start_at && new Date(booking.start_at).getTime() >= Date.now()) {
    throw new NoShowChargeError(
      'APPOINTMENT_NOT_PAST',
      'This appointment has not started yet. You can only mark a customer no-show after the appointment time has passed.',
    );
  }

  // Cancel the Square booking first. If it's already in a terminal
  // state we skip cancellation but still charge — a customer who
  // cancelled-late then was marked no-show is still a no-show.
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
      log({ phase: 'no-show-cancel-failed', bookingId: trimmed, detail });
      // Don't bail — we can still charge a no-show whose Square record
      // can't be re-cancelled (it might already be terminal under our
      // feet). Surface the issue but continue.
    }
  }

  try {
    // Shared idempotency prefix with the customer-facing late-cancel
    // endpoint so Square dedupes the rare TOCTOU race where both fire
    // at once.
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
    log({
      phase: 'no-show-charge-success',
      bookingId: trimmed,
      paymentId: payment.id,
      amountCents: card.servicePriceCents,
    });

    // Barber notification — let the assigned barber know their slot
    // was lost AND the shop already charged. Non-fatal; the charge has
    // landed already.
    void notifyBarberOfNoShowCharge({
      teamMemberId: booking.appointment_segments?.[0]?.team_member_id,
      customerId: booking.customer_id,
      serviceName: card.serviceName,
      whenLabelUtc: booking.start_at,
      amountCents: card.servicePriceCents,
    });

    return {
      ok: true,
      bookingId: trimmed,
      paymentId: payment.id,
      amountCents: card.servicePriceCents,
      cancelled,
    };
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
      // ignore secondary KV failure; the audit log below is the
      // canonical record of what we attempted.
    }
    log({ phase: 'no-show-charge-failed', bookingId: trimmed, detail });
    return {
      ok: true,
      bookingId: trimmed,
      amountCents: card.servicePriceCents,
      cancelled,
      chargeFailed: { detail },
    };
  }
}

function log(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[NO-SHOW] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

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

async function notifyBarberOfNoShowCharge(input: {
  teamMemberId: string | undefined;
  customerId: string | undefined;
  serviceName: string;
  whenLabelUtc: string | undefined;
  amountCents: number;
}): Promise<void> {
  try {
    if (!input.teamMemberId) {
      log({ phase: 'no-show-barber-notify-skipped-no-team-member' });
      return;
    }
    const [contact, customer] = await Promise.all([
      resolveBarberContact(input.teamMemberId),
      input.customerId ? getCustomerById(input.customerId).catch(() => null) : Promise.resolve(null),
    ]);
    if (!contact) {
      log({ phase: 'no-show-barber-notify-skipped-no-email', teamMemberId: input.teamMemberId });
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
    log({
      phase: 'no-show-barber-notify-sent',
      teamMemberId: input.teamMemberId,
      resendId: send.id,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log({
      phase: 'no-show-barber-notify-failed',
      teamMemberId: input.teamMemberId,
      detail,
    });
  }
}
