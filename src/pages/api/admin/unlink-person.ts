// Admin one-shot: drop the parent ↔ customer link.
//
// Counterpart to /api/admin/link-person. Used when an operator
// realizes a customer was linked to the wrong parent, or wants to
// clean up after a delete. Also called defensively from
// /api/admin/delete-customer so deleted customers don't leave
// zombie link records pointing at nothing.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import { getLinkedParent, unlinkPerson } from '../../../lib/customer/profileLinks';

export const prerender = false;

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

interface RequestBody {
  customerId?: string;
}

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
  const b = (body ?? {}) as RequestBody;
  const customerId = typeof b.customerId === 'string' ? b.customerId.trim() : '';
  if (!customerId) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'customerId is required.' } },
      { status: 400 },
    );
  }

  // Find the existing parent so we know who to write to. Idempotent
  // when there's no link — return ok with parent: null so the UI can
  // refresh confidently without surfacing an error toast.
  const parentId = await getLinkedParent(customerId).catch(() => null);
  if (!parentId) {
    return Response.json({ ok: true, customerId, parentId: null, alreadyUnlinked: true });
  }

  try {
    await unlinkPerson(parentId, customerId);
    logAdmin({ phase: 'admin-unlink-person', customerId, parentId });
    return Response.json({ ok: true, customerId, parentId, alreadyUnlinked: false });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({ phase: 'admin-unlink-person-failed', customerId, parentId, detail });
    return Response.json(
      { ok: false, error: { code: 'UNLINK_WRITE_FAILED', detail } },
      { status: 502 },
    );
  }
};
