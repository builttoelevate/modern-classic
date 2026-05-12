// POST /api/admin/barbers/rename-username — change the username on an
// existing barber account, keeping the password hash, email, and
// mustChangePassword flag intact.
//
// Why a dedicated endpoint vs. reusing /upsert: the existing upsert
// endpoint always (re)hashes a password — calling it for a pure
// rename would either force the admin to also reset the password OR
// leak a stale "use this generated password" string in the response.
// Cleaner to have a small endpoint that owns the rename use case.
//
// Reuses upsertAccount() under the hood, which already:
//   - rejects when the requested username is taken by a DIFFERENT
//     team member (returns 409 here)
//   - deletes the old reverse-lookup pointer on rename (no orphans)
//   - normalizes the username (lowercase, trimmed, ascii)

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getAccount,
  normalizeUsername,
  upsertAccount,
} from '../../../../lib/barber/accountStore';

export const prerender = false;

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

interface RequestBody {
  teamMemberId?: string;
  newUsername?: string;
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const b = (body ?? {}) as RequestBody;
  const teamMemberId = typeof b.teamMemberId === 'string' ? b.teamMemberId.trim() : '';
  const rawNewUsername = typeof b.newUsername === 'string' ? b.newUsername : '';
  if (!teamMemberId) return fail(400, 'BAD_REQUEST', 'teamMemberId is required.');
  if (!rawNewUsername.trim()) return fail(400, 'BAD_REQUEST', 'newUsername is required.');

  let normalized: string;
  try {
    normalized = normalizeUsername(rawNewUsername);
  } catch (err) {
    return fail(400, 'BAD_REQUEST', err instanceof Error ? err.message : 'Bad username.');
  }

  const existing = await getAccount(teamMemberId);
  if (!existing) {
    return fail(404, 'NOT_FOUND', 'No account for that team member.');
  }

  // No-op: same username after normalization. Surface success so the
  // admin's UI doesn't flash an error if they hit save without
  // changing anything.
  if (existing.username === normalized) {
    return Response.json({
      ok: true,
      teamMemberId,
      username: normalized,
      changed: false,
    });
  }

  try {
    const record = await upsertAccount({
      teamMemberId,
      username: normalized,
      // Preserve the existing password hash + flags. We're renaming
      // ONLY — the barber should not be forced to change their
      // password just because the admin renamed their handle.
      passwordHash: existing.passwordHash,
      mustChangePassword: existing.mustChangePassword,
      // email is undefined → upsertAccount preserves the existing
      // value (per its email-handling docstring).
    });
    logAdmin({
      phase: 'admin-barber-rename-username',
      teamMemberId,
      oldUsername: existing.username,
      newUsername: record.username,
    });
    return Response.json({
      ok: true,
      teamMemberId,
      username: record.username,
      previousUsername: existing.username,
      changed: true,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    // upsertAccount throws "username … is already taken" on conflict
    // — surface that as a 409 so the admin's UI shows a useful error.
    const isConflict = /already taken/i.test(detail);
    logAdmin({
      phase: 'admin-barber-rename-username-failed',
      teamMemberId,
      newUsername: normalized,
      detail,
    });
    return fail(
      isConflict ? 409 : 502,
      isConflict ? 'USERNAME_TAKEN' : 'RENAME_FAILED',
      detail,
    );
  }
};
