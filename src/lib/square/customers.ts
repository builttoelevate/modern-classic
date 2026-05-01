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
  const res = await squareFetch<SearchCustomersResponse>('/v2/customers/search', {
    method: 'POST',
    body: {
      query: { filter: { email_address: { exact: email } } },
      limit: 1,
    },
  });
  return res.customers?.[0] ?? null;
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
  patch: { givenName?: string; familyName?: string; phone?: string },
): Promise<Customer> {
  const body: Record<string, string | undefined> = {};
  if (patch.givenName !== undefined) body.given_name = patch.givenName;
  if (patch.familyName !== undefined) body.family_name = patch.familyName;
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
  /** What we did with the marketing consent flag, if anything. */
  marketingDecision: MarketingConsentDecision;
}

export async function findOrCreateCustomer(input: CustomerInput): Promise<FindOrCreateResult> {
  const existing = await findCustomerByEmail(input.email);
  if (!existing) {
    const created = await createCustomer(input);
    const decision = await applyMarketingConsent(created.id, input, true);
    return { customer: created, created: true, contactDiff: null, marketingDecision: decision };
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

  const decision = await applyMarketingConsent(customer.id, input, false);
  return {
    customer,
    created: false,
    contactDiff: diff && !input.updateContact ? diff : null,
    marketingDecision: decision,
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
        await setAttributeWithRetry(customerId, MARKETING_CONSENT_KEY, true);
        await setAttributeWithRetry(customerId, MARKETING_CONSENTED_AT_KEY, now);
        await setAttributeWithRetry(customerId, MARKETING_CONSENT_SOURCE_KEY, source);
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
    await setAttributeWithRetry(customerId, MARKETING_CONSENT_KEY, true);
    if (!current.consentedAt) {
      await setAttributeWithRetry(customerId, MARKETING_CONSENTED_AT_KEY, now);
    }
    await setAttributeWithRetry(customerId, MARKETING_CONSENT_SOURCE_KEY, source);
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
  attempts = 4,
): Promise<void> {
  let delay = 600;
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
