// Admin one-shot: bind a customer record to a parent so the parent's
// /my-bookings starts pulling that customer's bookings into the
// merged view (and into the BookingGroup banner when both members
// of a back-to-back are present).
//
// Why this exists: every now and then the parent ↔ kid Redis link
// drifts — Vercel/Upstash blip, an early bug, or someone deleted
// the kid's customer in admin without unlinking first. The shop
// loses visibility of the kid's appointments on the parent's
// portal until the link is restored. Before this endpoint, fixing
// it required hand-editing Redis. Now it's a button.
//
// The lookup is by parent's PHONE (not customerId) so the operator
// doesn't have to copy ids between tabs. We resolve via
// findCustomerByPhone, which already implements the prefer-record-
// with-email tie-breaker for duplicate phones.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import { findCustomerByPhone, getCustomerById } from '../../../lib/square/customers';
import {
  getLinkedParent,
  linkPerson,
  type LinkedPerson,
} from '../../../lib/customer/profileLinks';

export const prerender = false;

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function bad(detail: string, status = 400): Response {
  return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail } }, { status });
}

interface RequestBody {
  /** The customer who's being linked AS a kid (e.g. Briar). */
  customerId?: string;
  /** Phone of the parent to link them to (e.g. Bill's). Phone is the
   *  natural admin search field; we resolve it to a customer record
   *  server-side via findCustomerByPhone. */
  parentPhone?: string;
  /** Optional override for the displayName stored on the link
   *  record. Defaults to the kid's "Given Family" name from Square. */
  displayName?: string;
  /** Optional relationship label ("Son", "Daughter", "Partner", etc.). */
  relationship?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad('Body must be valid JSON.');
  }
  const b = (body ?? {}) as RequestBody;
  const customerId = typeof b.customerId === 'string' ? b.customerId.trim() : '';
  const parentPhone = typeof b.parentPhone === 'string' ? b.parentPhone.trim() : '';
  if (!customerId) return bad('customerId is required.');
  if (!parentPhone) return bad("Parent's phone is required.");

  // Confirm the kid record exists. Failure here is a 404 we surface
  // verbatim so the operator knows it wasn't a phone-lookup miss.
  let kid;
  try {
    kid = await getCustomerById(customerId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json(
      { ok: false, error: { code: 'LOOKUP_FAILED', detail } },
      { status: 502 },
    );
  }
  if (!kid) return bad('No customer with that id.', 404);

  // Find the parent by phone. Returns null if no match.
  let parent;
  try {
    parent = await findCustomerByPhone(parentPhone);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json(
      { ok: false, error: { code: 'PARENT_LOOKUP_FAILED', detail } },
      { status: 502 },
    );
  }
  if (!parent) {
    return bad("No customer found with that phone number.", 404);
  }
  if (parent.id === customerId) {
    return bad("Can't link a customer to themselves.");
  }

  // Defensive: refuse to overwrite an existing link to a different
  // parent without an explicit unlink first. Catches the case where
  // an operator accidentally re-links someone to the wrong parent.
  const existingParentId = await getLinkedParent(customerId).catch(() => null);
  if (existingParentId && existingParentId !== parent.id) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'ALREADY_LINKED',
          detail: 'This customer is already linked to a different parent. Unlink first.',
        },
        existingParentId,
      },
      { status: 409 },
    );
  }

  const displayName =
    (typeof b.displayName === 'string' && b.displayName.trim()) ||
    `${kid.given_name ?? ''} ${kid.family_name ?? ''}`.trim() ||
    'Linked person';
  const link: LinkedPerson = {
    customerId,
    displayName,
    relationship:
      typeof b.relationship === 'string' && b.relationship.trim()
        ? b.relationship.trim()
        : undefined,
    linkedAt: new Date().toISOString(),
  };

  try {
    await linkPerson(parent.id, link);
    logAdmin({
      phase: 'admin-link-person',
      parentId: parent.id,
      customerId,
      displayName,
    });
    return Response.json({
      ok: true,
      parent: {
        id: parent.id,
        displayName: `${parent.given_name ?? ''} ${parent.family_name ?? ''}`.trim() || 'Parent',
      },
      link,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({ phase: 'admin-link-person-failed', customerId, parentId: parent.id, detail });
    return Response.json(
      { ok: false, error: { code: 'LINK_WRITE_FAILED', detail } },
      { status: 502 },
    );
  }
};
