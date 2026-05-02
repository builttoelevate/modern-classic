import type { APIRoute } from 'astro';
import { requireSession, AuthRequiredError, refreshSessionCookie } from '../../../lib/auth/middleware';
import { getCustomerById, updateCustomer } from '../../../lib/square/customers';
import { SquareApiError } from '../../../lib/square/client';
import { redactEmail } from '../../../lib/booking/log';

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

function logCustomer(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[CUSTOMER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

/**
 * Customer-facing self-service profile update. Strictly scoped to the
 * caller's own Square customer record — the endpoint reads customerId
 * from the signed session cookie, never from the body. Anyone trying to
 * pass a different customerId field gets it ignored.
 */
export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be valid JSON.');
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const givenName = typeof b.givenName === 'string' ? b.givenName.trim().slice(0, 80) : undefined;
  const familyName = typeof b.familyName === 'string' ? b.familyName.trim().slice(0, 80) : undefined;
  const email = typeof b.email === 'string' ? b.email.trim().slice(0, 120) : undefined;
  const phone = typeof b.phone === 'string' ? b.phone.trim().slice(0, 32) : undefined;

  if (email !== undefined && email.length > 0 && !looksLikeEmail(email)) {
    return badRequest('Email is not in a valid format.');
  }
  if (phone !== undefined && phone.length > 0 && !looksLikePhone(phone)) {
    return badRequest('Phone needs at least 10 digits.');
  }

  // We require that EVERY logged-in profile keep a valid email + phone —
  // they're the channels Square uses for reminders and the channels we use
  // for sign-in. Letting someone clear those fields would also lock them
  // out of /my-bookings.
  if (email !== undefined && email.length === 0) {
    return badRequest('Email cannot be empty — it\'s how you sign in.');
  }
  if (phone !== undefined && phone.length === 0) {
    return badRequest('Phone cannot be empty — the shop uses it for reminders.');
  }

  let existing;
  try {
    existing = await getCustomerById(session.customerId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json(
      { ok: false, error: { code: 'LOOKUP_FAILED', detail } },
      { status: 502 },
    );
  }
  if (!existing) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'Your account record was not found.' } },
      { status: 404 },
    );
  }

  const patch: { givenName?: string; familyName?: string; email?: string; phone?: string } = {};
  if (givenName !== undefined && givenName !== (existing.given_name ?? '')) patch.givenName = givenName;
  if (familyName !== undefined && familyName !== (existing.family_name ?? '')) patch.familyName = familyName;
  if (email !== undefined && email.toLowerCase() !== (existing.email_address ?? '').toLowerCase()) {
    patch.email = email;
  }
  if (phone !== undefined && phone.replace(/[^0-9]/g, '') !== (existing.phone_number ?? '').replace(/[^0-9]/g, '')) {
    patch.phone = phone;
  }

  if (Object.keys(patch).length === 0) {
    const headers: HeadersInit = { 'Set-Cookie': refreshSessionCookie(session) };
    return Response.json({ ok: true, changed: false, customer: existing }, { headers });
  }

  try {
    const updated = await updateCustomer(session.customerId, patch);
    logCustomer({
      phase: 'self-update',
      customerId: session.customerId,
      email: redactEmail(session.email),
      changedFields: Object.keys(patch),
    });
    const headers: HeadersInit = { 'Set-Cookie': refreshSessionCookie(session) };
    return Response.json({ ok: true, changed: true, customer: updated, fields: Object.keys(patch) }, { headers });
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail } },
        { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logCustomer({ phase: 'self-update-failed', customerId: session.customerId, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }
};
