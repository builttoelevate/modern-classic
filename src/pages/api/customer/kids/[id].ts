import type { APIRoute } from 'astro';
import { requireSession, AuthRequiredError, refreshSessionCookie } from '../../../../lib/auth/middleware';
import {
  unlinkPerson,
  listLinkedPeople,
  getLinkedParent,
} from '../../../../lib/customer/profileLinks';

export const prerender = false;

function badRequest(detail: string, status = 400): Response {
  return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail } }, { status });
}

function logProfile(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[CUSTOMER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

/**
 * DELETE — unlink a linked person from this parent. Doesn't delete the
 * Square customer record (they may have past bookings that should remain
 * intact); just removes the parent → kid mapping. The Square record stays
 * findable in admin, just no longer claimed by anyone.
 */
export const DELETE: APIRoute = async ({ request, params }) => {
  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }

  const id = (params.id ?? '').toString().trim();
  if (!id) return badRequest('Missing linked-person id.');

  // Confirm the link belongs to THIS parent before unlinking — the URL
  // parameter is user-controlled so we can't trust it.
  let registeredParent;
  try {
    registeredParent = await getLinkedParent(id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { code: 'LOOKUP_FAILED', detail } }, { status: 502 });
  }
  if (!registeredParent) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'No such linked person.' } },
      { status: 404 },
    );
  }
  if (registeredParent !== session.customerId) {
    // 404, not 403, to avoid leaking that the link exists under someone
    // else's account.
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'No such linked person.' } },
      { status: 404 },
    );
  }

  try {
    await unlinkPerson(session.customerId, id);
    const remaining = await listLinkedPeople(session.customerId);
    logProfile({ phase: 'kid-removed', parentId: session.customerId, kidId: id });
    const headers: HeadersInit = { 'Set-Cookie': refreshSessionCookie(session) };
    return Response.json({ ok: true, people: remaining }, { headers });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logProfile({ phase: 'kid-unlink-failed', parentId: session.customerId, kidId: id, detail });
    return Response.json({ ok: false, error: { code: 'INTERNAL', detail } }, { status: 500 });
  }
};
