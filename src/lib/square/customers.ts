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
 * When multiple records share the same phone (test accounts,
 * pre-dedup duplicates), prefer the one with an email on file —
 * sign-in needs an email to deliver the magic link, so picking a
 * phone-only sibling dead-ends a customer who actually has a
 * usable account.
 */
export async function findCustomerByPhone(phone: string): Promise<Customer | null> {
  const all = await findCustomersByPhone(phone);
  return pickBestPhoneMatch(all);
}

/**
 * Returns every customer record whose phone matches (after digit-only
 * normalization on the trailing 10 digits). Used by the admin lookup
 * page to surface duplicates so the operator can see and merge them —
 * the singular findCustomerByPhone hides duplicates by design (it's
 * called by sign-in, which only ever needs one).
 */
export async function findCustomersByPhone(phone: string): Promise<Customer[]> {
  const e164 = normalizePhone(phone);
  if (!e164) return [];
  const targetTail = e164.replace(/\D/g, '').slice(-10);

  const exact = await squareFetch<SearchCustomersResponse>('/v2/customers/search', {
    method: 'POST',
    body: {
      query: { filter: { phone_number: { exact: e164 } } },
      limit: 20,
    },
  });
  const exactMatches = exact.customers ?? [];
  if (exactMatches.length > 0) return exactMatches;

  const fuzzy = await squareFetch<SearchCustomersResponse>('/v2/customers/search', {
    method: 'POST',
    body: {
      query: { filter: { phone_number: { fuzzy: e164 } } },
      limit: 20,
    },
  });
  return (fuzzy.customers ?? []).filter((c) => {
    const candidateTail = (c.phone_number ?? '').replace(/\D/g, '').slice(-10);
    return candidateTail.length > 0 && candidateTail === targetTail;
  });
}

/**
 * Lookup by display name — used by the admin /admin/customers
 * search field so the operator can find a customer they know by
 * name even when phone or email isn't to hand.
 *
 * Square's structured customer search filter does NOT support name
 * fields (only email/phone/reference_id/etc). The Square Dashboard
 * works around this by listing all customers and filtering client-
 * side; we mirror that approach.
 *
 * Sort by CREATED_AT DESC so the newest customers surface first —
 * the practical hit rate for admin name search skews heavily
 * toward recent customers (recently-booked, newly-added kids,
 * etc.). The initial implementation used the default order
 * (oldest first), which buried recent customers like Bill (Sep
 * 2025) and the Briar Bone records (May 2026) under hundreds of
 * older records, making the search miss them entirely.
 *
 * Cap at 8 pages (800 records). At ~300ms per page that's ~2.5s
 * worst case when no match is found — acceptable. The hit rate
 * for "look up someone created more than 800 records ago by
 * name" is low enough to not justify scanning deeper; for those
 * the operator can fall back to email or phone.
 */
export async function findCustomersByName(query: string): Promise<Customer[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const MAX_PAGES = 8;
  const MAX_RESULTS = 20;
  const out: Customer[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await squareFetch<{ customers?: Customer[]; cursor?: string }>(
      '/v2/customers',
      {
        query: {
          limit: 100,
          cursor,
          sort_field: 'CREATED_AT',
          sort_order: 'DESC',
        },
      },
    );
    const customers = res.customers ?? [];
    for (const c of customers) {
      const given = (c.given_name ?? '').toLowerCase();
      const family = (c.family_name ?? '').toLowerCase();
      const full = `${given} ${family}`.trim();
      if (tokens.every((t) => full.includes(t))) {
        out.push(c);
        if (out.length >= MAX_RESULTS) return out;
      }
    }
    cursor = res.cursor;
    if (!cursor) break;
  }
  return out;
}

function pickBestPhoneMatch(matches: Customer[]): Customer | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const createdMs = (c: Customer): number => {
    const v = c.created_at;
    if (!v) return 0;
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  // Sort: records with an email first, then most recently created.
  // hasEmail is the dominant signal because the only consumer that
  // calls this and then chains a magic-link send (auth/request) needs
  // an email to do anything useful — a phone-only sibling is a
  // dead-end for that caller.
  return [...matches].sort((a, b) => {
    const aHasEmail = (a.email_address ?? '').trim() ? 1 : 0;
    const bHasEmail = (b.email_address ?? '').trim() ? 1 : 0;
    if (aHasEmail !== bHasEmail) return bHasEmail - aHasEmail;
    return createdMs(b) - createdMs(a);
  })[0];
}

interface RetrieveCustomerResponse {
  customer?: Customer;
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  if (!id) return null;
  const res = await squareFetch<RetrieveCustomerResponse>(`/v2/customers/${id}`);
  return res.customer ?? null;
}

/**
 * Hard-delete a customer record. Square's DELETE /v2/customers/{id} is
 * idempotent and returns an empty body on success. The caller is
 * responsible for upstream guards (e.g. blocking delete when the
 * customer has bookings on file) — this function will happily delete
 * any record the API accepts.
 */
export async function deleteCustomer(id: string): Promise<void> {
  if (!id) throw new Error('deleteCustomer: id is required');
  await squareFetch<unknown>(`/v2/customers/${id}`, { method: 'DELETE' });
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
  // Look up by email AND phone in parallel. Email is the stronger
  // signal (phone numbers get reassigned, emails generally don't), so
  // when both hit different records we prefer the email match. Phone
  // is the fallback that closes the dedup gap: if a phone-only record
  // exists (booked at the chair without an email), the next booking
  // with that phone — which DOES carry an email — folds into that
  // record instead of minting a sibling. Without this fallback we'd
  // recreate the "Ben test" / "Bill" duplicate pattern on every
  // phone-only-then-online conversion.
  const [byEmail, byPhone] = await Promise.all([
    findCustomerByEmail(input.email),
    findCustomerByPhone(input.phone).catch(() => null),
  ]);

  // Phone reassignment guard: if we matched by phone and the existing
  // record has a *different* email, treat the booker as a new person
  // and create a fresh record. Reusing in that case would route the
  // booking confirmation to the previous owner of the number.
  const existingEmail = (byPhone?.email_address ?? '').trim().toLowerCase();
  const inputEmailLc = input.email.trim().toLowerCase();
  const phoneMatchHasDifferentEmail =
    !!byPhone && !!existingEmail && existingEmail !== inputEmailLc;

  const existing = byEmail ?? (phoneMatchHasDifferentEmail ? null : byPhone);

  if (!existing) {
    const created = await createCustomer(input);
    return {
      customer: created,
      created: true,
      contactDiff: null,
      marketingDecisionPromise: applyMarketingConsent(created.id, input, true),
    };
  }

  const matchedByPhoneOnly = !byEmail;
  const shouldBackfillEmail =
    matchedByPhoneOnly && !(existing.email_address ?? '').trim() && !!inputEmailLc;
  const diff = computeDiff(existing, input);

  let customer = existing;
  if ((diff && input.updateContact) || shouldBackfillEmail) {
    customer = await updateCustomer(existing.id, {
      givenName: diff?.givenName !== undefined && input.updateContact ? input.givenName : undefined,
      familyName: diff?.familyName !== undefined && input.updateContact ? input.familyName : undefined,
      phone: diff?.phone !== undefined && input.updateContact ? input.phone : undefined,
      email: shouldBackfillEmail ? input.email : undefined,
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

export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  // Square accepts E.164. Default to US (+1) if missing.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return input;
}
