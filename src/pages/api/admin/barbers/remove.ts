import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { deleteAccount, getAccount } from '../../../../lib/barber/accountStore';

export const prerender = false;

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
    return Response.json({ ok: true, removed: false });
  }
  await deleteAccount(teamMemberId);
  return Response.json({ ok: true, removed: true });
};
