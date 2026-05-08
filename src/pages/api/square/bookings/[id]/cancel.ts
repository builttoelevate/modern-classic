import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { AuthRequiredError, requireSession, refreshSessionCookie } from '../../../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../../../lib/auth/session';
import { SquareApiError } from '../../../../../lib/square/client';
import { getBooking, cancelBooking } from '../../../../../lib/square/bookings';
import { listLinkedPeople } from '../../../../../lib/customer/profileLinks';
import { redactEmail } from '../../../../../lib/booking/log';
import {
  getBookingCardRecord,
  markBookingCharged,
  markBookingChargeFailed,
} from '../../../../../lib/booking/cardIndex';
import { chargeCardOnFile } from '../../../../../lib/square/payments';

export const prerender = false;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface CancelRequestBody {
  /** When the booking is within 24h AND has a card on file, the My
   *  Bookings UI must surface a confirmation modal and only proceed if
   *  the customer explicitly accepts the charge. We require the flag
   *  here so a CSRF-style click can't sneak through and charge them. */
  acceptCharge?: boolean;
}

function logAction(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BOOK] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ params, request }) => {
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

  const id = params.id;
  if (!id || typeof id !== 'string') {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Booking id is required.' } },
      { status: 400 },
    );
  }

  let booking;
  try {
    booking = await getBooking(id);
  } catch (err) {
    if (err instanceof SquareApiError && (err.status === 404 || err.code === 'NOT_FOUND')) {
      return Response.json(
        { ok: false, error: { code: 'NOT_FOUND', detail: 'Booking not found.' } },
        { status: 404 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'cancel-fetch-failed', bookingId: id, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not load booking.' } },
      { status: 500 },
    );
  }

  // Ownership check: the booking belongs to the signed-in customer OR
  // to one of their linked people (kids / family members booked from
  // the parent's profile, or auto-linked via the group flow). Without
  // the linked-people branch, the parent couldn't cancel any group
  // member's booking other than their own — every group member after
  // the first is under a different Square customer record by design.
  let allowed = !!booking.customer_id && booking.customer_id === session.customerId;
  if (!allowed && booking.customer_id) {
    try {
      const linked = await listLinkedPeople(session.customerId);
      allowed = linked.some((p) => p.customerId === booking.customer_id);
    } catch {
      // KV hiccup — fall through to the FORBIDDEN response. Better to
      // refuse than to leak cancellation rights on a transient error.
    }
  }
  if (!allowed) {
    logAction({
      phase: 'cancel-forbidden',
      bookingId: id,
      sessionEmail: redactEmail(session.email),
    });
    return Response.json(
      { ok: false, error: { code: 'FORBIDDEN', detail: 'This booking does not belong to you.' } },
      { status: 403 },
    );
  }

  // Late-cancel branch: inside the 24h window we used to refuse outright
  // and tell the user to phone the shop. With the new-customer card-on-
  // file flow that's no longer the right answer for *every* booking —
  // if the customer agreed to the cancellation policy at booking time
  // and we have a card on file, they may cancel here as long as they
  // explicitly accept the charge. Returning customers without a card
  // still get the "call the shop" message because we have nothing to
  // charge them.
  const startMs = new Date(booking.start_at).getTime();
  const within24h = startMs - Date.now() < TWENTY_FOUR_HOURS_MS;

  let acceptCharge = false;
  try {
    const raw = await request.text();
    if (raw && raw.length > 0) {
      const parsed = JSON.parse(raw) as CancelRequestBody;
      acceptCharge = parsed.acceptCharge === true;
    }
  } catch {
    acceptCharge = false;
  }

  let cardRecord: Awaited<ReturnType<typeof getBookingCardRecord>> = null;
  if (within24h) {
    try {
      cardRecord = await getBookingCardRecord(booking.id);
    } catch (kvErr) {
      const detail = kvErr instanceof Error ? kvErr.message : String(kvErr);
      logAction({ phase: 'cancel-card-lookup-failed', bookingId: id, detail });
    }
    // 'pending' = never charged; 'failed' = previous charge errored
    // (e.g. transient 5xx from Square / a network blip during the
    // first cancel attempt). Both are eligible for a fresh charge — we
    // don't want to permanently strand a customer who hit the cancel
    // button at the wrong moment. Any other status (already charged,
    // late-cancel/no-show) means the cancellation has already happened
    // and we just refuse.
    if (
      !cardRecord ||
      (cardRecord.chargeStatus !== 'pending' && cardRecord.chargeStatus !== 'failed')
    ) {
      return Response.json(
        {
          ok: false,
          error: {
            code: 'TOO_LATE_TO_CANCEL',
            detail: 'Within 24 hours — please call the shop at 740-297-4462.',
          },
        },
        { status: 400 },
      );
    }
    if (!acceptCharge) {
      // The wizard's late-cancel modal hasn't been confirmed yet.
      // Return a structured 409 so the UI can render its warning instead
      // of generic "could not cancel" copy.
      return Response.json(
        {
          ok: false,
          error: {
            code: 'CANCEL_REQUIRES_CHARGE_ACCEPT',
            detail:
              'You are within 24 hours of your appointment. Cancelling now will charge your card on file the full service price. Confirm to proceed.',
          },
          chargeAmountCents: cardRecord.servicePriceCents,
        },
        { status: 409 },
      );
    }
  }

  const idempotencyKey = `mc-cancel-${createHash('sha256')
    .update(`${booking.id}|${booking.version}`)
    .digest('hex')}`;

  try {
    const cancelled = await cancelBooking({
      bookingId: booking.id,
      bookingVersion: booking.version,
      idempotencyKey,
    });
    logAction({
      phase: 'cancel-success',
      bookingId: cancelled.id,
      sessionEmail: redactEmail(session.email),
      within24h,
    });

    // If we got here on the within-24h branch, the customer has already
    // confirmed they accept the charge. Pull the trigger now. Charge
    // failure does NOT un-cancel the booking — the slot is gone either
    // way; we just mark the index entry 'failed' so Michael can see it
    // on the admin dashboard and follow up manually.
    let chargeFailureMessage: string | null = null;
    if (within24h && cardRecord) {
      try {
        // Idempotency key is shared with the admin no-show endpoint
        // (mc-charge-{bookingId}). Square dedupes within 24h on this
        // key, so a TOCTOU race where Michael clicks "no-show" at
        // exactly the moment a customer accepts the late-cancel charge
        // produces ONE Square payment, not two. The KV chargeStatus
        // check above gates entry into this block; the shared key is
        // the second line of defense if both endpoints pass that gate
        // simultaneously.
        const payment = await chargeCardOnFile({
          customerId: cardRecord.squareCustomerId,
          cardId: cardRecord.squareCardId,
          amountCents: cardRecord.servicePriceCents,
          idempotencyKey: `mc-charge-${booking.id}`,
          note: `Late cancel (within 24h) — booking ${booking.id}, ${cardRecord.serviceName}`,
        });
        await markBookingCharged({
          bookingId: booking.id,
          chargeStatus: 'late-cancel',
          chargedPaymentId: payment.id,
        });
        logAction({
          phase: 'late-cancel-charge-success',
          bookingId: booking.id,
          paymentId: payment.id,
          amountCents: cardRecord.servicePriceCents,
        });
      } catch (chargeErr) {
        const detail =
          chargeErr instanceof SquareApiError
            ? `${chargeErr.code}: ${chargeErr.detail}`
            : chargeErr instanceof Error
              ? chargeErr.message
              : String(chargeErr);
        chargeFailureMessage = detail;
        try {
          await markBookingChargeFailed(booking.id, detail);
        } catch {
          // ignore secondary KV failure; the primary log entry below
          // is the audit record.
        }
        logAction({
          phase: 'late-cancel-charge-failed',
          bookingId: booking.id,
          detail,
        });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        bookingId: cancelled.id,
        status: cancelled.status,
        ...(within24h && cardRecord
          ? {
              charge: chargeFailureMessage
                ? { ok: false, detail: chargeFailureMessage }
                : { ok: true, amountCents: cardRecord.servicePriceCents },
            }
          : {}),
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
    if (err instanceof SquareApiError) {
      logAction({
        phase: 'cancel-square-error',
        bookingId: id,
        code: err.code,
        detail: err.detail,
        sessionEmail: redactEmail(session.email),
      });
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail || 'Square rejected the cancel.' } },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    logAction({ phase: 'cancel-failed', bookingId: id, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not cancel booking.' } },
      { status: 500 },
    );
  }
};
