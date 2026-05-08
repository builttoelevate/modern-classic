import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { SquareApiError } from '../../../lib/square/client';
import { getCustomerById } from '../../../lib/square/customers';
import { createCardOnFile } from '../../../lib/square/cards';
import { redactEmail } from '../../../lib/booking/log';

export const prerender = false;

// Saves a Square Web Payments SDK card nonce as a card-on-file under the
// given Square customer record. Called from the booking wizard's
// card-capture step (Step 4.5) after the visitor's email/phone has been
// resolved to a customer_id by /api/booking/check-new-customer.
//
// Stores nothing locally yet — the booking → card mapping is written to
// Upstash KV only when the booking itself is created (in
// /api/square/bookings), so a nonce that successfully tokenizes but
// never makes it to a booking doesn't leave orphaned KV entries.

interface RequestBody {
  customerId?: string;
  /** "cnon:..." — single-use payment-method nonce from card.tokenize(). */
  sourceId?: string;
  /** Pulled from the booking form so the Square dashboard reads
   *  consistently with the booking. Optional. */
  cardholderName?: string;
}

interface SuccessResponse {
  ok: true;
  cardId: string;
  last4?: string;
  brand?: string;
}

interface FailureResponse {
  ok: false;
  error: { code: string; detail: string };
}

function fail(status: number, code: string, detail: string): Response {
  const body: FailureResponse = { ok: false, error: { code, detail } };
  return Response.json(body, { status });
}

export const POST: APIRoute = async ({ request }) => {
  let payload: RequestBody;
  try {
    payload = (await request.json()) as RequestBody;
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }

  const customerId = (payload.customerId ?? '').trim();
  const sourceId = (payload.sourceId ?? '').trim();
  const cardholderName = (payload.cardholderName ?? '').trim() || undefined;

  if (!customerId) return fail(400, 'BAD_REQUEST', 'customerId is required.');
  if (!sourceId) return fail(400, 'BAD_REQUEST', 'sourceId is required.');

  try {
    // Verify the customer exists before we try to attach a card. A
    // typo'd / spoofed customer id would otherwise produce a confusing
    // Square 4xx mid-card-capture.
    const customer = await getCustomerById(customerId);
    if (!customer) {
      return fail(400, 'CUSTOMER_NOT_FOUND', 'No matching customer record found.');
    }

    // Idempotency: deterministic hash of (customerId, sourceId) so that
    // a double-clicked "Continue" button replays as the SAME Square
    // request and Square returns the same card instead of creating a
    // second one. A genuine retry by the user with a fresh card will
    // arrive with a different sourceId (the nonce is single-use), so
    // the key naturally differs across distinct attempts.
    const idempotencyKey = `mc-card-${createHash('sha256')
      .update(`${customerId}|${sourceId}`)
      .digest('hex')
      .slice(0, 48)}`;

    const card = await createCardOnFile({
      customerId,
      sourceId,
      cardholderName,
      idempotencyKey,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[BOOK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'card-saved',
        customerId,
        cardId: card.id,
        last4: card.last_4,
        brand: card.card_brand,
        customerEmail: redactEmail(customer.email_address),
      })}`,
    );

    const body: SuccessResponse = {
      ok: true,
      cardId: card.id,
      last4: card.last_4,
      brand: card.card_brand,
    };
    return Response.json(body, { status: 200 });
  } catch (err) {
    if (err instanceof SquareApiError) {
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'save-card-square-error',
          customerId,
          code: err.code,
          detail: err.detail,
        })}`,
      );
      // Card-decline / verification errors come back as 4xx — pass them
      // through so the wizard can surface "card declined, try another".
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return fail(status, err.code, err.detail || 'Square refused the card.');
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.log(
      `[BOOK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'save-card-failed',
        customerId,
        detail,
      })}`,
    );
    return fail(500, 'INTERNAL', 'Could not save the card. Please try again.');
  }
};
