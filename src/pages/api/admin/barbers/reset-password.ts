import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getAccount,
  updateAccountPassword,
} from '../../../../lib/barber/accountStore';
import { generateDefaultPassword, hashPassword } from '../../../../lib/auth/passwordHash';

export const prerender = false;

// Admin resets a barber's password. Generates a fresh random 10-char
// default, returns the plaintext once so the admin page can show it
// to Michael, and flips mustChangePassword back on so the barber is
// prompted to set their own on next login.

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

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
  const teamMemberId = typeof b.teamMemberId === 'string' ? b.teamMemberId.trim() : '';
  if (!teamMemberId) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'teamMemberId is required.' } },
      { status: 400 },
    );
  }
  const existing = await getAccount(teamMemberId);
  if (!existing) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'No account for that team member.' } },
      { status: 404 },
    );
  }

  const plaintext = generateDefaultPassword(10);
  const hash = await hashPassword(plaintext);
  await updateAccountPassword(teamMemberId, hash, true);
  return Response.json({
    ok: true,
    teamMemberId,
    username: existing.username,
    generatedPassword: plaintext,
  });
};
