import type { APIRoute } from 'astro';
import { getAccountByUsername, updateAccountPassword } from '../../../../lib/barber/accountStore';
import {
  buildBarberSessionCookie,
  signBarberSession,
} from '../../../../lib/auth/barberSession';
import { verifyPassword } from '../../../../lib/auth/passwordHash';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
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
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!username || !password) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Username and password are required.' } },
      { status: 400 },
    );
  }

  const account = await getAccountByUsername(username);
  // Constant-ish response shape regardless of which check failed —
  // don't leak whether the username exists.
  if (!account) {
    return Response.json(
      { ok: false, error: { code: 'INVALID_CREDENTIALS', detail: 'Username or password is incorrect.' } },
      { status: 401 },
    );
  }
  const ok = await verifyPassword(password, account.passwordHash);
  if (!ok) {
    return Response.json(
      { ok: false, error: { code: 'INVALID_CREDENTIALS', detail: 'Username or password is incorrect.' } },
      { status: 401 },
    );
  }

  const token = signBarberSession({
    barberId: account.teamMemberId,
    username: account.username,
  });
  // Touch updatedAt so the admin page can see "last login" rough ordering.
  // We don't store a separate lastLoginAt key — updatedAt is good enough
  // for a 3-person shop.
  await updateAccountPassword(
    account.teamMemberId,
    account.passwordHash,
    account.mustChangePassword,
  );
  return new Response(
    JSON.stringify({ ok: true, mustChangePassword: account.mustChangePassword }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': buildBarberSessionCookie(token),
      },
    },
  );
};
