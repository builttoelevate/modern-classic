// Square Cards API wrapper — saves a card-on-file for a customer using a
// payment-method nonce produced by the Square Web Payments SDK in the
// browser. The card is stored at Square; we only persist the returned
// card_id locally (in our KV booking→card index). Never the PAN/CVV.
//
// Used by /api/booking/save-card on the new-customer card-capture step of
// the booking wizard. The captured card is later charged by:
//   - the customer themselves accepting the late-cancel charge in
//     /my-bookings (cancel endpoint)
//   - Michael clicking "Mark no-show & charge" in /admin/bookings
// There is no automated cron — every charge is a deliberate human action.

import { squareFetch } from './client';

export interface SquareCard {
  id: string;
  customer_id: string;
  card_brand?: string;
  last_4?: string;
  exp_month?: number;
  exp_year?: number;
  enabled?: boolean;
}

interface CreateCardResponse {
  card?: SquareCard;
}

export interface CreateCardOnFileInput {
  customerId: string;
  /** payment-method nonce ("source_id") returned by Square Web Payments SDK
   *  card.tokenize() in the browser. Single-use; expires within minutes. */
  sourceId: string;
  /** A unique key that lets Square dedupe accidental retries — caller
   *  should make this stable for the user's card-capture attempt. */
  idempotencyKey: string;
  /** Optional cardholder name pulled from the booking form so the
   *  Square dashboard reads consistently. */
  cardholderName?: string;
}

/**
 * POST /v2/cards — store a card-on-file under the given customer record.
 * Returns the saved card (id + last4 + brand) on success.
 */
export async function createCardOnFile(input: CreateCardOnFileInput): Promise<SquareCard> {
  const body = {
    idempotency_key: input.idempotencyKey,
    source_id: input.sourceId,
    card: {
      customer_id: input.customerId,
      ...(input.cardholderName ? { cardholder_name: input.cardholderName } : {}),
    },
  };
  const res = await squareFetch<CreateCardResponse>('/v2/cards', {
    method: 'POST',
    body,
  });
  if (!res.card?.id) {
    throw new Error('Square /v2/cards POST returned no card');
  }
  return res.card;
}

interface RetrieveCardResponse {
  card?: SquareCard;
}

/** Look up a saved card by id. Returns null on 404 / disabled. */
export async function getCard(cardId: string): Promise<SquareCard | null> {
  if (!cardId) return null;
  try {
    const res = await squareFetch<RetrieveCardResponse>(`/v2/cards/${cardId}`);
    if (!res.card) return null;
    if (res.card.enabled === false) return null;
    return res.card;
  } catch {
    return null;
  }
}
