import { squareFetch } from './client';
import type {
  CreateCustomerResponse,
  Customer,
  SearchCustomersResponse,
  UpdateCustomerResponse,
} from './types';

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
}

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
}

export async function findOrCreateCustomer(input: CustomerInput): Promise<FindOrCreateResult> {
  const existing = await findCustomerByEmail(input.email);
  if (!existing) {
    const created = await createCustomer(input);
    return { customer: created, created: true, contactDiff: null };
  }

  const diff = computeDiff(existing, input);

  if (diff && input.updateContact) {
    const updated = await updateCustomer(existing.id, {
      givenName: diff.givenName !== undefined ? input.givenName : undefined,
      familyName: diff.familyName !== undefined ? input.familyName : undefined,
      phone: diff.phone !== undefined ? input.phone : undefined,
    });
    return { customer: updated, created: false, contactDiff: null };
  }

  return { customer: existing, created: false, contactDiff: diff };
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
