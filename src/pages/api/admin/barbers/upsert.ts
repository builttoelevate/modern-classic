import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getAccount,
  normalizeUsername,
  upsertAccount,
} from '../../../../lib/barber/accountStore';
import { generateDefaultPassword, hashPassword } from '../../../../lib/auth/passwordHash';
import { getBarbers } from '../../../../lib/square/team';

export const prerender = false;

// Provision (or rename) a barber's login. Body:
//   { teamMemberId: string, username: string, password?: string }
//
// Behavior:
//   - teamMemberId must belong to a current Square team member.
//   - If password is omitted, we generate a random 10-char default and
//     return the plaintext in the response so the admin page can show
//     it once. Either way, the returned password is the one the barber
//     should use on next login.
//   - mustChangePassword is always set to true on upsert — the barber
//     is expected to set their own after first login.

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
  const rawUsername = typeof b.username === 'string' ? b.username : '';
  const rawPassword = typeof b.password === 'string' && b.password.length > 0 ? b.password : null;

  if (!teamMemberId) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'teamMemberId is required.' } },
      { status: 400 },
    );
  }
  let username: string;
  try {
    username = normalizeUsername(rawUsername);
  } catch (err) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: err instanceof Error ? err.message : 'Bad username.' } },
      { status: 400 },
    );
  }

  // Sanity-check: refuse to provision an account for a team_member_id
  // that doesn't appear in the active Square roster. Avoids creating
  // logins for ex-employees or typo'd IDs.
  try {
    const barbers = await getBarbers();
    if (!barbers.some((m) => m.id === teamMemberId)) {
      return Response.json(
        {
          ok: false,
          error: {
            code: 'UNKNOWN_TEAM_MEMBER',
            detail: 'That team member ID is not on the active Square roster.',
          },
        },
        { status: 400 },
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Could not load Square team.';
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 502 },
    );
  }

  const plaintextPassword = rawPassword ?? generateDefaultPassword(10);
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(plaintextPassword);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Failed to hash password.';
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }

  try {
    const record = await upsertAccount({
      teamMemberId,
      username,
      passwordHash,
      mustChangePassword: true,
    });
    return Response.json({
      ok: true,
      account: {
        teamMemberId: record.teamMemberId,
        username: record.username,
        mustChangePassword: record.mustChangePassword,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      // Plaintext password — display once and instruct admin to share it
      // out-of-band. The client should not store this anywhere durable.
      generatedPassword: plaintextPassword,
      generated: rawPassword === null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Could not save the account.';
    const code = /taken/i.test(detail) ? 'USERNAME_TAKEN' : 'INTERNAL';
    return Response.json(
      { ok: false, error: { code, detail } },
      { status: code === 'USERNAME_TAKEN' ? 409 : 500 },
    );
  }
};

// Help the admin page display "does this barber already have an
// account?" without a second round trip.
export const GET: APIRoute = async ({ request, url }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;
  const id = url.searchParams.get('teamMemberId');
  if (!id) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'teamMemberId is required.' } },
      { status: 400 },
    );
  }
  const rec = await getAccount(id);
  return Response.json({
    ok: true,
    account: rec
      ? {
          teamMemberId: rec.teamMemberId,
          username: rec.username,
          mustChangePassword: rec.mustChangePassword,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        }
      : null,
  });
};
