import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import {
  getAccount,
  updateAccountPassword,
} from '../../../../lib/barber/accountStore';
import { hashPassword, verifyPassword } from '../../../../lib/auth/passwordHash';

export const prerender = false;

const MIN_PASSWORD_LENGTH = 8;

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
  const currentPassword = typeof b.currentPassword === 'string' ? b.currentPassword : '';
  const newPassword = typeof b.newPassword === 'string' ? b.newPassword : '';
  if (!currentPassword || !newPassword) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Current and new password are required.' } },
      { status: 400 },
    );
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'WEAK_PASSWORD',
          detail: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        },
      },
      { status: 400 },
    );
  }
  if (newPassword === currentPassword) {
    return Response.json(
      {
        ok: false,
        error: { code: 'SAME_PASSWORD', detail: 'New password must be different from the current one.' },
      },
      { status: 400 },
    );
  }

  const account = await getAccount(session.barberId);
  if (!account) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'Account no longer exists.' } },
      { status: 404 },
    );
  }
  const ok = await verifyPassword(currentPassword, account.passwordHash);
  if (!ok) {
    return Response.json(
      { ok: false, error: { code: 'INVALID_CREDENTIALS', detail: 'Current password is incorrect.' } },
      { status: 401 },
    );
  }

  const newHash = await hashPassword(newPassword);
  await updateAccountPassword(session.barberId, newHash, false);
  return Response.json({ ok: true });
};
