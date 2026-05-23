import type { APIRoute } from 'astro';
import { SquareApiError } from '../../../lib/square/client';
import {
  findCustomerByEmail,
  findCustomerByPhone,
  createCustomer,
} from '../../../lib/square/customers';
import { hasAnyPriorBooking } from '../../../lib/square/customerHistory';
import { redactEmail } from '../../../lib/booking/log';

export const prerender = false;

// Decides whether a visitor about to book is "new to us" (no prior
// booking under any matching Square customer record). The booking
// wizard calls this between Step 4 (Details) and Step 5 (Confirm) to
// decide whether to show the card-capture step.
//
// A customer is NEW when:
//   - no Square customer record exists for either email or phone, OR
//   - record(s) exist but none have a booking in the past year / next
//     ~60 days. (Bookings older than that don't matter for our policy —
//     someone who hasn't visited in a year may as well be new again.)
//
// On NEW, we eagerly create the Square customer record so the
// /api/booking/save-card call (next step in the wizard) has a
// customer_id to attach the card to. The booking endpoint will see this
// id come back via existingCustomerId and skip its own findOrCreate
// pass.
//
// On RETURNING, we just return the existing customer's id and let the
// wizard skip the card-capture step entirely.

interface RequestBody {
  /** Known-customer branch: signed-in self or a linked dependent.
   *  When set, we skip the email/phone lookup and createCustomer paths
   *  and just check Square's booking history under this customerId. */
  customerId?: string;
  email?: string;
  phone?: string;
  givenName?: string;
  familyName?: string;
}

interface SuccessResponse {
  ok: true;
  /** Pure newness signal — true when Square has no prior/upcoming
   *  bookings for this customer. Independent of card-capture config.
   *  Drives the Step 1 service-routing gate. */
  isNew: boolean;
  /** Card-capture gate. Equals isNew && cardCaptureConfigured. Drives
   *  Step 4.5. Replaces the legacy `newCustomer` field (which conflated
   *  the two signals — newCustomer:false leaked out when card capture
   *  wasn't configured even for true new customers). */
  requiresCard: boolean;
  customerId: string;
}

interface FailureResponse {
  ok: false;
  error: { code: string; detail: string };
}

function fail(status: number, code: string, detail: string): Response {
  const body: FailureResponse = { ok: false, error: { code, detail } };
  return Response.json(body, { status });
}

function digits(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}

// Without these the Square Web Payments SDK can't render the card form,
// so Step 4.5 dead-ends with "Card capture is not configured." When that
// happens we bypass the card-on-file requirement and let the booking go
// through anyway — better to take the booking than turn the customer
// away. Auto-restores once both env vars are populated on Vercel.
function isCardCaptureConfigured(): boolean {
  const appId =
    (import.meta.env.PUBLIC_SQUARE_APPLICATION_ID as string | undefined) ?? '';
  const locationId =
    (import.meta.env.PUBLIC_SQUARE_LOCATION_ID as string | undefined) ?? '';
  return appId.trim().length > 0 && locationId.trim().length > 0;
}

export const POST: APIRoute = async ({ request }) => {
  let payload: RequestBody;
  try {
    payload = (await request.json()) as RequestBody;
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }

  const cardCaptureConfigured = isCardCaptureConfigured();

  // Known-customer branch — signed-in self or a linked dependent from
  // the "Booking for" selector. We already have a Square customerId
  // from the session / KV link, so skip the email/phone lookup +
  // createCustomer paths entirely and just check booking history.
  const customerIdInput = (payload.customerId ?? '').trim();
  if (customerIdInput) {
    try {
      const isNew = !(await hasAnyPriorBooking(customerIdInput));
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: isNew ? 'new-customer-detected' : 'returning-customer-detected',
          customerId: customerIdInput,
          source: 'customer-id-branch',
        })}`,
      );
      const body: SuccessResponse = {
        ok: true,
        isNew,
        requiresCard: isNew && cardCaptureConfigured,
        customerId: customerIdInput,
      };
      return Response.json(body, { status: 200 });
    } catch (err) {
      // Fail open — let the caller treat as returning if Square errors.
      const detail = err instanceof Error ? err.message : 'Unknown error';
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'check-new-customer-by-id-failed',
          customerId: customerIdInput,
          detail,
        })}`,
      );
      return fail(502, 'SQUARE_ERROR', 'Could not check customer history.');
    }
  }

  const email = (payload.email ?? '').trim().toLowerCase();
  const phone = (payload.phone ?? '').trim();
  const givenName = (payload.givenName ?? '').trim();
  const familyName = (payload.familyName ?? '').trim();

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return fail(400, 'BAD_REQUEST', 'A valid email is required.');
  }
  if (digits(phone).length < 10) {
    return fail(400, 'BAD_REQUEST', 'A 10-digit phone number is required.');
  }
  if (!givenName || !familyName) {
    return fail(400, 'BAD_REQUEST', 'First and last name are required.');
  }

  if (!cardCaptureConfigured) {
    // eslint-disable-next-line no-console
    console.log(
      `[BOOK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'card-capture-bypassed-not-configured',
        customerEmail: redactEmail(email),
      })}`,
    );
  }

  try {
    // Look up by email AND phone in parallel — the same person may have
    // booked previously under either one. If both hit a record we prefer
    // the email match (higher signal — phone numbers get reassigned).
    const [byEmail, byPhone] = await Promise.all([
      findCustomerByEmail(email),
      findCustomerByPhone(phone).catch(() => null),
    ]);

    const candidates = [byEmail, byPhone].filter(
      (c): c is NonNullable<typeof c> => !!c && !!c.id,
    );

    if (candidates.length === 0) {
      // True new customer. Create the Square record now so save-card has
      // somewhere to attach the card. We only persist what we already
      // collected in Step 4 — no marketing consent yet (that's still on
      // Step 5 in the existing flow and is best-effort metadata).
      const created = await createCustomer({
        givenName,
        familyName,
        email,
        phone,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'new-customer-detected',
          customerId: created.id,
          customerEmail: redactEmail(email),
          source: 'create',
        })}`,
      );
      const body: SuccessResponse = {
        ok: true,
        isNew: true,
        requiresCard: cardCaptureConfigured,
        customerId: created.id,
      };
      return Response.json(body, { status: 200 });
    }

    // One or more existing records. Check each for prior booking
    // history in parallel; if any returns true, treat as returning.
    const histories = await Promise.all(
      candidates.map((c) =>
        hasAnyPriorBooking(c.id)
          .then((had) => ({ id: c.id, had }))
          .catch(() => ({ id: c.id, had: false })),
      ),
    );
    const returning = histories.find((h) => h.had);
    if (returning) {
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'returning-customer-detected',
          customerId: returning.id,
          customerEmail: redactEmail(email),
        })}`,
      );
      const body: SuccessResponse = {
        ok: true,
        isNew: false,
        requiresCard: false,
        customerId: returning.id,
      };
      return Response.json(body, { status: 200 });
    }

    // Customer record exists but no booking history found — treat as new
    // for card-capture purposes. Reuse the existing record (don't create
    // a duplicate). Prefer the email match if both exist.
    const reuseId = (byEmail ?? candidates[0]).id;
    // eslint-disable-next-line no-console
    console.log(
      `[BOOK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'new-customer-detected',
        customerId: reuseId,
        customerEmail: redactEmail(email),
        source: 'reuse-existing-record-no-history',
      })}`,
    );
    const body: SuccessResponse = {
      ok: true,
      isNew: true,
      requiresCard: cardCaptureConfigured,
      customerId: reuseId,
    };
    return Response.json(body, { status: 200 });
  } catch (err) {
    if (err instanceof SquareApiError) {
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'check-new-customer-square-error',
          code: err.code,
          detail: err.detail,
          customerEmail: redactEmail(email),
        })}`,
      );
      return fail(502, err.code, err.detail || 'Square call failed.');
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.log(
      `[BOOK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'check-new-customer-failed',
        detail,
        customerEmail: redactEmail(email),
      })}`,
    );
    return fail(500, 'INTERNAL', 'Could not check customer history.');
  }
};
