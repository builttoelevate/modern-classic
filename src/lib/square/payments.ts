// Square Payments API wrapper — charges a card-on-file. Used by:
//   - /api/square/bookings/[id]/cancel  (customer accepted the late-cancel
//     charge inside the 24h window)
//   - /api/admin/bookings/no-show-charge (Michael marked the customer no-show)
//
// Every call here represents a deliberate human decision to charge — there
// is no automated billing in this codebase.

import { squareFetch } from './client';
import { MODERN_CLASSIC_LOCATION_ID } from './locations';

export interface SquarePayment {
  id: string;
  status: 'APPROVED' | 'COMPLETED' | 'CANCELED' | 'FAILED' | 'PENDING';
  amount_money?: { amount: number; currency: string };
  receipt_url?: string;
  receipt_number?: string;
}

interface CreatePaymentResponse {
  payment?: SquarePayment;
}

export interface ChargeCardOnFileInput {
  customerId: string;
  /** Saved card id (cnon:... → /v2/cards → card.id). */
  cardId: string;
  amountCents: number;
  /** Stable per-booking idempotency key, e.g. `noshow-{bookingId}` or
   *  `late-cancel-{bookingId}`, so retries never double-charge. */
  idempotencyKey: string;
  /** Free-form internal note attached to the payment for reconciliation
   *  in the Square dashboard. Not visible to the customer. */
  note?: string;
  currency?: string;
}

/**
 * POST /v2/payments — charge a previously-saved card. autocomplete=true
 * captures immediately; we don't auth-and-hold for these flows because
 * the trigger is a fait-accompli (the appointment was missed / late-
 * cancelled).
 */
export async function chargeCardOnFile(input: ChargeCardOnFileInput): Promise<SquarePayment> {
  const body = {
    idempotency_key: input.idempotencyKey,
    source_id: input.cardId,
    customer_id: input.customerId,
    location_id: MODERN_CLASSIC_LOCATION_ID,
    amount_money: {
      amount: input.amountCents,
      currency: input.currency ?? 'USD',
    },
    autocomplete: true,
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
  };
  const res = await squareFetch<CreatePaymentResponse>('/v2/payments', {
    method: 'POST',
    body,
  });
  if (!res.payment?.id) {
    throw new Error('Square /v2/payments POST returned no payment');
  }
  return res.payment;
}
