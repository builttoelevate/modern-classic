// DELETE /api/admin/blocks/:id — remove a block by its stable UUID.
// Phone-keyed delete is intentionally not exposed; using ids forces the
// page to send a stable identifier and prevents accidentally unblocking
// the wrong record because of a phone-format mismatch.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { removeBlockedById } from '../../../../lib/customer/blockedCustomers';

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;
  const id = (params.id ?? '').trim();
  if (!id) {
    return Response.json(
      { ok: false, error: { detail: 'id is required in the path.' } },
      { status: 400 },
    );
  }
  try {
    const removed = await removeBlockedById(id);
    if (!removed) {
      return Response.json(
        { ok: false, error: { detail: 'No block with that id.' } },
        { status: 404 },
      );
    }
    return Response.json({ ok: true, removed: true, block: removed }, { status: 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { detail } }, { status: 500 });
  }
};
