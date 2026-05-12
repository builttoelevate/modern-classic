// Admin endpoints for the own-list block-from-booking enforcement.
//
// GET    /api/admin/blocks            list all blocked phones
// POST   /api/admin/blocks            body { phone, reason?, blockedBy? }
// DELETE /api/admin/blocks            body { phone }
//
// All three are gated by the existing admin Basic Auth. Phone is
// normalized to E.164 before storage / lookup, so callers can pass
// any reasonable input ("(740) 297-4462", "740-297-4462",
// "+17402974462" — all become "+17402974462").
//
// One-time migration path for Michael: walk the Square "Block from
// booking" toggle list, POST each phone here with a short reason.
// A proper admin UI is a follow-up; curl / Postman is fine for the
// initial pass.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import {
  addBlockedPhone,
  listBlockedPhones,
  removeBlockedPhone,
} from '../../../lib/customer/blockedCustomers';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;
  try {
    const entries = await listBlockedPhones();
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
      { ok: true, added: result.added, entry: result.entry },
      { status: 200 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { detail } }, { status: 400 });
  }
};

export const DELETE: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;
  let body: { phone?: unknown };
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
  try {
    const removed = await removeBlockedPhone(phone);
    return Response.json({ ok: true, removed }, { status: 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { detail } }, { status: 500 });
  }
};
