// Admin one-shot: remove a single customer from their family.
//
// Used when a family ended up with the wrong member (e.g., a kid
// joined an adult's family by mistake, or an adult should never have
// been in the family in the first place). When this drops the last
// adult, the family is auto-dissolved by removeFamilyMember — that's
// the existing contract, not a special-case here.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getFamilyForCustomer,
  removeFamilyMember,
} from '../../../../lib/customer/familyAccount';

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

  // Idempotent on "not in any family" — return ok so the UI refresh
  // doesn't surface a confusing error when an admin double-taps.
  const family = await getFamilyForCustomer(customerId).catch(() => null);
  if (!family) {
    return Response.json({
      ok: true,
      customerId,
      familyId: null,
      dissolved: false,
      alreadyRemoved: true,
    });
  }

  try {
    const updated = await removeFamilyMember(family.familyId, customerId);
    const dissolved = updated === null;
    logAdmin({
      phase: 'admin-family-remove-member',
      customerId,
      familyId: family.familyId,
      dissolved,
      membersAfter: updated?.members.length ?? 0,
    });
    return Response.json({
      ok: true,
      customerId,
      familyId: family.familyId,
      dissolved,
      alreadyRemoved: false,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({
      phase: 'admin-family-remove-member-failed',
      customerId,
      familyId: family.familyId,
      detail,
    });
    return Response.json(
      { ok: false, error: { code: 'REMOVE_FAILED', detail } },
      { status: 502 },
    );
  }
};
