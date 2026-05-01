import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import { updateWaitlistStatus, type WaitlistStatus } from '../../../lib/marketing/waitlistLog';

export const prerender = false;

const ALLOWED: WaitlistStatus[] = ['new', 'contacted', 'booked', 'archived'];

function badRequest(detail: string, status = 400): Response {
  return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail } }, { status });
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be valid JSON.');
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  const status = typeof b.status === 'string' ? (b.status.trim() as WaitlistStatus) : '';
  const adminNote = typeof b.adminNote === 'string' ? b.adminNote.trim().slice(0, 600) : undefined;

  if (!id) return badRequest('id is required.');
  if (!ALLOWED.includes(status as WaitlistStatus)) {
    return badRequest(`status must be one of: ${ALLOWED.join(', ')}.`);
  }

  try {
    const updated = await updateWaitlistStatus({ id, status: status as WaitlistStatus, adminNote });
    if (!updated) return badRequest('No waitlist entry with that id.', 404);
    return Response.json({ ok: true, entry: updated });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), phase: 'waitlist-status-failed', id, detail })}`);
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }
};
