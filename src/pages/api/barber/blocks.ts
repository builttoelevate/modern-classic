// Barber-facing block-list endpoint. Same operations as the admin
// endpoint (/api/admin/blocks) but gated by a barber session instead of
// admin Basic Auth — every signed-in barber can block AND unblock a
// customer from online booking. The block list is shop-wide (keyed by
// phone), so a block one barber adds protects every barber's calendar.
//
//   GET  /api/barber/blocks            list everything, newest first
//   POST /api/barber/blocks            { phone, reason? }   → block
//                                      { removeId }         → unblock
//
// Unblock is POST (not DELETE) on purpose: the DELETE method to a
// dynamic route is unreliable from mobile browsers, so we keep every
// mutation on this one static POST endpoint. blockedBy is stamped with
// the acting barber's name for the audit trail.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  requireBarberSession,
} from '../../../lib/auth/barberMiddleware';
import {
  addBlockedPhone,
  listBlockedEntries,
  removeBlockedById,
} from '../../../lib/customer/blockedCustomers';
import { getBarbers } from '../../../lib/square/team';

export const prerender = false;

async function barberDisplayName(barberId: string, fallback: string): Promise<string> {
  try {
    const all = await getBarbers();
    return all.find((b) => b.id === barberId)?.displayName || fallback;
  } catch {
    return fallback;
  }
}

export const GET: APIRoute = async ({ request }) => {
  try {
    requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }
  try {
    const entries = await listBlockedEntries();
    return Response.json({ ok: true, entries }, { status: 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { detail } }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  let body: { phone?: unknown; reason?: unknown; removeId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { ok: false, error: { detail: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }

  // Unblock by id.
  const removeId = typeof body.removeId === 'string' ? body.removeId.trim() : '';
  if (removeId) {
    try {
      const removed = await removeBlockedById(removeId);
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
  }

  // Block by phone.
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!phone) {
    return Response.json(
      { ok: false, error: { detail: 'phone or removeId is required.' } },
      { status: 400 },
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
  const blockedBy = (await barberDisplayName(session.barberId, session.username)).slice(0, 100);
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
