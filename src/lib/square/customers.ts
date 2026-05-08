import { squareFetch, SquareApiError } from './client';
import type {
  CreateCustomerResponse,
  Customer,
  SearchCustomersResponse,
  UpdateCustomerResponse,
} from './types';
import {
  MARKETING_CONSENT_KEY,
  MARKETING_CONSENTED_AT_KEY,
  MARKETING_CONSENT_SOURCE_KEY,
  getAllMarketingAttributes,
  setCustomAttribute,
} from './customAttributes';

export interface CustomerInput {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  /**
   * When true, an existing record is updated with the supplied phone/name
   * if they differ. When false (default), the existing record is left as-is
   * and we book against the existing contact info — surface any diff in
   * the UI so the user can confirm.
   */
  updateContact?: boolean;
  /**
   * Phase 7 — whether the customer ticked the marketing-consent checkbox
   * on the booking flow. Optional; absent means no signal (don't touch
   * existing consent state, don't create new consent state).
   */
  marketingConsent?: boolean;
  /**
   * Phase 7 — surface that captured the consent. Defaults to
   * "booking_flow_step_4" on first opt-in via the wizard. Future surfaces
   * (e.g. "shop_checkout") can pass their own.
   */
  marketingConsentSource?: string;
}

export type MarketingConsentDecision =
  | { kind: 'noop'; reason: 'no-signal' | 'unchanged-true' | 'cannot-revoke-via-form' }
  | { kind: 'set'; consent: true; consentedAt: string; source: string }
  | { kind: 'failed'; reason: string };

export async function findCustomerByEmail(email: string): Promise<Customer | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  // Try exact first — fastest, deterministic when Square's stored email
  // matches byte-for-byte.
  const exact = await squareFetch<SearchCustomersResponse>('/v2/customers/search', {
    method: 'POST',
    body: {
      query: { filter: { email_address: { exact: normalized } } },
      limit: 1,
    },
  });
  if (exact.customers && exact.customers.length > 0) return exact.customers[0];

  // Fuzzy fallback for case/whitespace quirks Square's exact filter
  // sometimes misses. We still post-filter by case-insensitive equality so
  // we don't accidentally match a different customer whose email
  // shares a substring.
  const fuzzy = await squareFetch<SearchCustomersResponse>('/v2/customers/search', {
    method: 'POST',
    body: {
      query: { filter: { email_address: { fuzzy: normalized } } },
      limit: 20,
    },
  });
  for (const c of fuzzy.customers ?? []) {
    if ((c.email_address ?? '').trim().toLowerCase() === normalized) return c;
  }
  return null;
}

/**
 * Lookup by phone — used by the customer portal sign-in flow as a
 * fallback when an existing client doesn't remember which email they
 * used to book (or if they were booked phone-only and have no email
 * on file at all). Tries Square's exact filter first, then fuzzy.
 *
 * Returns the customer; the caller decides what to do if there's no
 * email on file. We don't send SMS — that needs a separate provider.
 */
export async function findCustomerByPhone(phone: string): Promise<Customer | null> {
  const e164 = normalizePhone(phone);
  if (!e164) return null;

  // Square's phone exact filter expects E.164 format. We compare against
  // the trailing 10 digits below for the fuzzy pass since shop staff
  // may have entered the number any-which-way over the years.
  const exact = await squareFetch<SearchCustomersResponse>('/v2/customers/search', {
    method: 'POST',
    body: {
      query: { filter: { phone_number: { exact: e164 } } },
      limit: 1,
    },
  });
  if (exact.customers && exact.customers.length > 0) return exact.customers[0];

  const fuzzy = await squareFetch<SearchCustomersResponse>('/v2/customers/search', {
    method: 'POST',
    body: {
      query: { filter: { phone_number: { fuzzy: e164 } } },
      limit: 20,
    },
  });
  const targetTail = e164.replace(/\D/g, '').slice(-10);
  for (const c of fuzzy.customers ?? []) {
    const candidateTail = (c.phone_number ?? '').replace(/\D/g, '').slice(-10);
    if (candidateTail && candidateTail === targetTail) return c;
  }
  return null;
}

interface RetrieveCustomerResponse {
  customer?: Customer;
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  if (!id) return null;
  const res = await squareFetch<RetrieveCustomerResponse>(`/v2/customers/${id}`);
  return res.customer ?? null;
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const res = await squareFetch<CreateCustomerResponse>('/v2/customers', {
    method: 'POST',
    body: {
      given_name: input.givenName,
      family_name: input.familyName,
      email_address: input.email,
      phone_number: normalizePhone(input.phone),
    },
  });
  if (!res.customer) {
    throw new Error('Square /v2/customers POST returned no customer');
  }
  return res.customer;
}

export async function updateCustomer(
  id: string,
  patch: { givenName?: string; familyName?: string; email?: string; phone?: string },
): Promise<Customer> {
  const body: Record<string, string | undefined> = {};
  if (patch.givenName !== undefined) body.given_name = patch.givenName;
  if (patch.familyName !== undefined) body.family_name = patch.familyName;
  if (patch.email !== undefined) body.email_address = patch.email.trim().toLowerCase() || undefined;
  if (patch.phone !== undefined) body.phone_number = normalizePhone(patch.phone);
  const res = await squareFetch<UpdateCustomerResponse>(`/v2/customers/${id}`, {
    method: 'PUT',
    body,
  });
  if (!res.customer) throw new Error('Square /v2/customers PUT returned no customer');
  return res.customer;
}

export interface FindOrCreateResult {
  customer: Customer;
  /** True when we created a new record. False when we found an existing one. */
  created: boolean;
  /** When matched and form data differs from the existing record. */
  contactDiff: { phone?: string; givenName?: string; familyName?: string } | null;
  /**
   * Marketing consent application is intentionally NOT awaited here — it
   * runs against Square's Custom Attributes API which can be slow to
   * propagate for newly-created customers, and a consent write failure
   * never blocks the booking. The caller can await this promise in
   * parallel with createBooking() so the response time is max(booking,
   * consent), not booking + consent. Always resolves; never rejects.
   */
  marketingDecisionPromise: Promise<MarketingConsentDecision>;
}

export async function findOrCreateCustomer(input: CustomerInput): Promise<FindOrCreateResult> {
  const existing = await findCustomerByEmail(input.email);
  if (!existing) {
    const created = await createCustomer(input);
    return {
      customer: created,
      created: true,
      contactDiff: null,
      marketingDecisionPromise: applyMarketingConsent(created.id, input, true),
    };
  }

  const diff = computeDiff(existing, input);

  let customer = existing;
  if (diff && input.updateContact) {
    customer = await updateCustomer(existing.id, {
      givenName: diff.givenName !== undefined ? input.givenName : undefined,
      familyName: diff.familyName !== undefined ? input.familyName : undefined,
      phone: diff.phone !== undefined ? input.phone : undefined,
    });
  }

  return {
    customer,
    created: false,
    contactDiff: diff && !input.updateContact ? diff : null,
    marketingDecisionPromise: applyMarketingConsent(customer.id, input, false),
  };
}

/**
 * Marketing consent rules (Phase 7):
 *  - NEW customer: write whatever the form said. true → also write
 *    consented_at + consent_source. false/undefined → write false (no
 *    timestamps).
 *  - EXISTING customer with consent === true and form unchecked: NOOP.
 *    We never silently revoke. Unsubscribe lives behind the unsubscribe
 *    link only.
 *  - EXISTING customer with consent !== true and form true: flip true,
 *    set consented_at and consent_source.
 *  - EXISTING customer with consent === true and form true: NOOP. Don't
 *    refresh the timestamp every booking — the original timestamp is the
 *    legally relevant one.
 */
async function applyMarketingConsent(
  customerId: string,
  input: CustomerInput,
  isNewCustomer: boolean,
): Promise<MarketingConsentDecision> {
  try {
    const formConsent = input.marketingConsent;
    const source = input.marketingConsentSource ?? 'booking_flow_step_4';

    if (isNewCustomer) {
      if (formConsent === true) {
        const now = new Date().toISOString();
        // Run the three attribute writes in parallel — they're
        // independent of one another, and Square's CA API was the
        // single biggest blocker on booking response time.
        await Promise.all([
          setAttributeWithRetry(customerId, MARKETING_CONSENT_KEY, true),
          setAttributeWithRetry(customerId, MARKETING_CONSENTED_AT_KEY, now),
          setAttributeWithRetry(customerId, MARKETING_CONSENT_SOURCE_KEY, source),
        ]);
        return { kind: 'set', consent: true, consentedAt: now, source };
      }
      // For new customers we record an explicit false so the field is set
      // and analytics can distinguish "never asked" from "asked & declined".
      await setAttributeWithRetry(customerId, MARKETING_CONSENT_KEY, false);
      return { kind: 'noop', reason: 'no-signal' };
    }

    // Existing customer.
    if (formConsent !== true) {
      return { kind: 'noop', reason: 'cannot-revoke-via-form' };
    }

    const current = await getAllMarketingAttributes(customerId);
    if (current.consent === true) {
      return { kind: 'noop', reason: 'unchanged-true' };
    }

    const now = new Date().toISOString();
    const writes: Array<Promise<void>> = [
      setAttributeWithRetry(customerId, MARKETING_CONSENT_KEY, true),
      setAttributeWithRetry(customerId, MARKETING_CONSENT_SOURCE_KEY, source),
    ];
    if (!current.consentedAt) {
      writes.push(setAttributeWithRetry(customerId, MARKETING_CONSENTED_AT_KEY, now));
    }
    await Promise.all(writes);
    return { kind: 'set', consent: true, consentedAt: now, source };
  } catch (err) {
    // Never let a consent write fail the booking. Log it and move on —
    // the customer's appointment matters more than this metadata, and
    // they can opt in again on their next booking.
    const detail =
      err instanceof SquareApiError
        ? `${err.code}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : String(err);
    // eslint-disable-next-line no-console
    console.log(
      `[BOOK] ${JSON.stringify({
        ts: new Date().toISOString(),
        phase: 'consent-write-failed',
        customerId,
        detail,
      })}`,
    );
    return { kind: 'failed', reason: detail };
  }
}

/**
 * Newly-created customers occasionally take a moment to be visible to the
 * Custom Attributes API — Square returns NOT_FOUND for a beat or two after
 * createCustomer succeeds. Retry once or twice with backoff before
 * surfacing the failure.
 */
async function setAttributeWithRetry(
  customerId: string,
  key: string,
  value: string | boolean | null,
  attempts = 3,
): Promise<void> {
  let delay = 400;
  for (let i = 1; i <= attempts; i++) {
    try {
      await setCustomAttribute(customerId, key, value);
      return;
    } catch (err) {
      const isPropagation =
        err instanceof SquareApiError &&
        (err.code === 'NOT_FOUND' || err.status === 404);
      // eslint-disable-next-line no-console
      console.log(
        `[BOOK] ${JSON.stringify({
          ts: new Date().toISOString(),
          phase: 'consent-write-attempt',
          attempt: i,
          key,
          customerId,
          willRetry: isPropagation && i < attempts,
          code: err instanceof SquareApiError ? err.code : 'UNKNOWN',
          status: err instanceof SquareApiError ? err.status : 0,
        })}`,
      );
      if (!isPropagation || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
    }
  }
}

function computeDiff(
  existing: Customer,
  input: CustomerInput,
): { phone?: string; givenName?: string; familyName?: string } | null {
  const diff: { phone?: string; givenName?: string; familyName?: string } = {};
  const existingPhoneDigits = (existing.phone_number ?? '').replace(/\D/g, '').slice(-10);
  const inputPhoneDigits = input.phone.replace(/\D/g, '').slice(-10);
  if (existingPhoneDigits && inputPhoneDigits && existingPhoneDigits !== inputPhoneDigits) {
    diff.phone = existing.phone_number;
  }
  if (
    input.givenName.trim() &&
    existing.given_name &&
    existing.given_name.trim() !== input.givenName.trim()
  ) {
    diff.givenName = existing.given_name;
  }
  if (
    input.familyName.trim() &&
    existing.family_name &&
    existing.family_name.trim() !== input.familyName.trim()
  ) {
    diff.familyName = existing.family_name;
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  // Square accepts E.164. Default to US (+1) if missing.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return input;
}
