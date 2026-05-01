import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import { getCustomerById, updateCustomer } from '../../../lib/square/customers';
import { SquareApiError } from '../../../lib/square/client';

export const prerender = false;

function looksLikeEmail(s: string): boolean {
  return /^\S+@\S+\.\S+$/.test(s.trim());
}

function looksLikePhone(s: string): boolean {
  const d = s.replace(/[^0-9]/g, '');
  return d.length >= 10 && d.length <= 16;
}

function badRequest(detail: string, status = 400): Response {
  return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail } }, { status });
}

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be valid JSON.');
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const customerId = typeof b.customerId === 'string' ? b.customerId.trim() : '';
  if (!customerId) return badRequest('customerId is required.');

  // Optional fields — empty string means "leave alone", undefined also means
  // "leave alone". The admin UI sends every field but only ones the operator
  // actually edited come through with new values.
  const givenName = typeof b.givenName === 'string' ? b.givenName.trim() : undefined;
  const familyName = typeof b.familyName === 'string' ? b.familyName.trim() : undefined;
  const email = typeof b.email === 'string' ? b.email.trim() : undefined;
  const phone = typeof b.phone === 'string' ? b.phone.trim() : undefined;

  if (email && email.length > 0 && !looksLikeEmail(email)) {
    return badRequest('Email is not in a valid format.');
  }
  if (phone && phone.length > 0 && !looksLikePhone(phone)) {
    return badRequest('Phone needs at least 10 digits.');
  }

  // Confirm the customer exists before patching — Square's PUT /customers/{id}
  // happily creates a new customer if the id doesn't match, which would be a
  // surprising failure mode for admin staff.
  let existing;
  try {
    existing = await getCustomerById(customerId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json(
      { ok: false, error: { code: 'LOOKUP_FAILED', detail } },
      { status: 502 },
    );
  }
  if (!existing) {
    return badRequest('No customer with that id.', 404);
  }

  // Build the patch — only include fields the operator actually changed.
  const patch: { givenName?: string; familyName?: string; email?: string; phone?: string } = {};
  if (givenName !== undefined && givenName !== (existing.given_name ?? '')) {
    patch.givenName = givenName;
  }
  if (familyName !== undefined && familyName !== (existing.family_name ?? '')) {
    patch.familyName = familyName;
  }
  if (email !== undefined && email !== (existing.email_address ?? '')) {
    patch.email = email;
  }
  if (phone !== undefined && phone.replace(/[^0-9]/g, '') !== (existing.phone_number ?? '').replace(/[^0-9]/g, '')) {
    patch.phone = phone;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ ok: true, customer: existing, changed: false });
  }

  try {
    const updated = await updateCustomer(customerId, patch);
    logAdmin({
      phase: 'customer-updated',
      customerId,
      changedFields: Object.keys(patch),
    });
    return Response.json({ ok: true, customer: updated, changed: true, fields: Object.keys(patch) });
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail } },
        { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({ phase: 'customer-update-failed', customerId, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }
};
