import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getAccount,
  updateAccountEmail,
} from '../../../../lib/barber/accountStore';

export const prerender = false;

// Admin updates a barber's notification email without touching their
// password. Pass an empty string to clear.

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
  const rawEmail = typeof b.email === 'string' ? b.email : '';
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
  try {
    const updated = await updateAccountEmail(teamMemberId, rawEmail);
    return Response.json({
      ok: true,
      teamMemberId,
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
