// Admin endpoints for the block-list. Basic Auth (admin/<ADMIN_PASSWORD>).
//
//   GET  /api/admin/blocks    list everything, newest first
//   POST /api/admin/blocks    body {phone, reason?, blockedBy?}
//                             → {ok, status: 'created' | 'already_blocked', block}
//                             (idempotent; duplicate is NOT an error)
//
// DELETE moved to /api/admin/blocks/[id] (by stable UUID).
// /check moved to /api/admin/blocks/check (admin-auth-only inspection).

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import {
  addBlockedPhone,
  listBlockedEntries,
} from '../../../lib/customer/blockedCustomers';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;
  try {
    const entries = await listBlockedEntries();
    return Response.json({ ok: true, entries }, { status: 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { detail } }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;
  let body: { phone?: unknown; reason?: unknown; blockedBy?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { ok: false, error: { detail: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!phone) {
    return Response.json(
      { ok: false, error: { detail: 'phone is required.' } },
      { status: 400 },
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
  const blockedBy =
    typeof body.blockedBy === 'string' ? body.blockedBy.trim().slice(0, 100) : undefined;
  try {
    const result = await addBlockedPhone(phone, { reason, blockedBy });
    return Response.json(
      { ok: true, status: result.status, block: result.block },
      { status: 200 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { detail } }, { status: 400 });
  }
};
