import type { APIRoute } from 'astro';
import { findCustomerByEmail } from '../../../lib/square/customers';
import { SquareApiError } from '../../../lib/square/client';

export const prerender = false;

// Used by Step 5 to surface the "we have different contact info on file"
// banner. We deliberately return ONLY the fields the user already typed in
// — never leak unrelated PII from someone else's record.

export const GET: APIRoute = async ({ url }) => {
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail: 'email is required' } }, { status: 400 });
  }
  try {
    const c = await findCustomerByEmail(email);
    if (!c) return Response.json({ ok: true, exists: false });
    return Response.json({
      ok: true,
      exists: true,
      givenName: c.given_name ?? '',
      familyName: c.family_name ?? '',
      phone: c.phone_number ?? '',
    });
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail } },
        { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
      );
    }
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: err instanceof Error ? err.message : 'unknown' } },
      { status: 500 },
    );
  }
};
