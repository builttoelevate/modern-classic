import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import {
  getAccount,
  updateAccountEmail,
} from '../../../../lib/barber/accountStore';

export const prerender = false;

// Lets the logged-in barber update (or clear) the inbox where their
// waitlist notifications get delivered. Pass an empty string to fall
// back to the Square TeamMember.email_address resolution.

export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const rawEmail = typeof b.email === 'string' ? b.email : '';

  const account = await getAccount(session.barberId);
  if (!account) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'Account no longer exists.' } },
      { status: 404 },
    );
  }

  try {
    const updated = await updateAccountEmail(session.barberId, rawEmail);
    return Response.json({
      ok: true,
      email: updated?.email ?? null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Could not update email.';
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail } },
      { status: 400 },
    );
  }
};
