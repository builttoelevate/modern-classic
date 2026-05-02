import type { APIRoute } from 'astro';
import { requireSession, AuthRequiredError, refreshSessionCookie } from '../../../lib/auth/middleware';
import { createCustomer, getCustomerById } from '../../../lib/square/customers';
import { SquareApiError } from '../../../lib/square/client';
import {
  linkPerson,
  listLinkedPeople,
  type LinkedPerson,
} from '../../../lib/customer/profileLinks';

export const prerender = false;

const RELATIONSHIP_LIMIT = 32;
const NAME_LIMIT = 60;
const MAX_LINKED_PER_PARENT = 12;

function badRequest(detail: string, status = 400): Response {
  return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail } }, { status });
}

function logProfile(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[CUSTOMER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

/**
 * GET — list the current parent's linked people. Used by the profile
 * page (server-rendered) and by the booking wizard's "Booking for"
 * selector (which already has them via SSR, but kept here for
 * completeness in case the wizard ever needs to refresh client-side).
 */
export const GET: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }
  try {
    const people = await listLinkedPeople(session.customerId);
    const headers: HeadersInit = { 'Set-Cookie': refreshSessionCookie(session) };
    return Response.json({ ok: true, people }, { headers });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { code: 'INTERNAL', detail } }, { status: 500 });
  }
};

/**
 * POST — add a new linked person under this parent. Creates a Square
 * customer record (with the linked person's name and the parent's
 * phone for SMS routing — no email; kids generally don't have one),
 * then persists the parent → linked customerId mapping in KV.
 */
export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be valid JSON.');
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const givenName = typeof b.givenName === 'string' ? b.givenName.trim().slice(0, NAME_LIMIT) : '';
  const familyName = typeof b.familyName === 'string' ? b.familyName.trim().slice(0, NAME_LIMIT) : '';
  const relationship =
    typeof b.relationship === 'string' && b.relationship.trim().length > 0
      ? b.relationship.trim().slice(0, RELATIONSHIP_LIMIT)
      : undefined;

  if (!givenName) return badRequest('First name is required.');

  // Cap the per-parent list so the wizard's selector stays usable. Twelve
  // is comfortably more than any single household will need.
  const existing = await listLinkedPeople(session.customerId);
  if (existing.length >= MAX_LINKED_PER_PARENT) {
    return badRequest(`You can link up to ${MAX_LINKED_PER_PARENT} people. Remove one first.`);
  }

  // Get the parent's record so we can borrow their phone (SMS routing) +
  // family name (default surname) for the new linked record.
  let parent;
  try {
    parent = await getCustomerById(session.customerId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { code: 'LOOKUP_FAILED', detail } }, { status: 502 });
  }
  if (!parent) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'Your account record was not found.' } },
      { status: 404 },
    );
  }

  const parentPhone = (parent.phone_number ?? '').trim();
  // No email on linked records — Square's reminder email goes to the
  // email_address field; we want SMS to the parent's phone, not email
  // to the kid's nonexistent address.
  const parentSurname = familyName || (parent.family_name ?? '').trim();

  let created;
  try {
    created = await createCustomer({
      givenName,
      familyName: parentSurname,
      email: '',
      phone: parentPhone,
    });
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail } },
        { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logProfile({ phase: 'kid-create-failed', parentId: session.customerId, detail });
    return Response.json({ ok: false, error: { code: 'INTERNAL', detail } }, { status: 500 });
  }

  const link: LinkedPerson = {
    customerId: created.id,
    displayName: `${givenName}${parentSurname ? ' ' + parentSurname : ''}`.trim(),
    relationship,
    linkedAt: new Date().toISOString(),
  };

  try {
    await linkPerson(session.customerId, link);
  } catch (err) {
    // Square record exists but KV write failed — log loudly. The customer
    // can re-add and the dedupe in linkPerson will catch the second create
    // (well, no — dedupe is on customerId, and the second attempt creates
    // a fresh Square record). Worth a follow-up to wire a cleanup, but
    // realistically Upstash failures are rare.
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logProfile({
      phase: 'kid-link-write-failed',
      parentId: session.customerId,
      kidId: created.id,
      detail,
    });
    return Response.json(
      { ok: false, error: { code: 'KV_WRITE_FAILED', detail } },
      { status: 502 },
    );
  }

  logProfile({
    phase: 'kid-added',
    parentId: session.customerId,
    kidId: created.id,
    relationship: relationship ?? null,
  });
  const headers: HeadersInit = { 'Set-Cookie': refreshSessionCookie(session) };
  return Response.json({ ok: true, person: link }, { headers });
};
