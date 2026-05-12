// Admin one-shot: add a customer to a target family by adult-email
// hint. Two paths:
//
//   1. Target adult IS already in a family — add the new customer
//      to that existing family.
//   2. Target adult ISN'T in a family yet — create a fresh family
//      with them as founder, then add the new customer.
//
// Used when a customer got their own one-person family by mistake
// and should actually be in a spouse's family, or to seed a kid
// directly under an existing family. The "wrong family already"
// case is handled gracefully: if the customer is already in some
// OTHER family, the add fails with ALREADY_IN_FAMILY (matches the
// addFamilyMember invariant) and the admin is expected to remove
// them first.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { findCustomerByEmail, getCustomerById } from '../../../../lib/square/customers';
import {
  addFamilyMember,
  createFamily,
  getFamilyForCustomer,
  MAX_FAMILY_ADULTS,
  MAX_FAMILY_MEMBERS,
  type FamilyRole,
} from '../../../../lib/customer/familyAccount';

export const prerender = false;

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

interface RequestBody {
  customerId?: string;
  targetAdultEmail?: string;
  role?: FamilyRole;
}

function bad(detail: string, code = 'BAD_REQUEST', status = 400): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

function resolveDisplayName(
  c: { given_name?: string | null; family_name?: string | null; email_address?: string | null } | null,
  fallback: string,
): string {
  if (!c) return fallback;
  const full = `${c.given_name ?? ''} ${c.family_name ?? ''}`.trim();
  if (full) return full;
  if (c.email_address) return c.email_address.split('@')[0] ?? fallback;
  return fallback;
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
  const targetAdultEmail =
    typeof b.targetAdultEmail === 'string' ? b.targetAdultEmail.trim() : '';
  const role: FamilyRole = b.role === 'kid' ? 'kid' : 'adult';
  if (!customerId) return bad('customerId is required.');
  if (!targetAdultEmail) return bad("Target adult's email is required.");
  if (!/^\S+@\S+\.\S+$/.test(targetAdultEmail)) {
    return bad('Target adult email looks malformed.');
  }
  if (customerId === '' || !customerId.trim()) {
    return bad('customerId is required.');
  }

  // Look up the target adult by email.
  const targetAdult = await findCustomerByEmail(targetAdultEmail).catch(() => null);
  if (!targetAdult) {
    return bad('No customer found with that email.', 'TARGET_NOT_FOUND', 404);
  }
  if (targetAdult.id === customerId) {
    return bad(
      "Can't add a customer to a family with themselves as the target adult.",
      'SELF_TARGET',
    );
  }

  // Refuse if the source customer is already in a DIFFERENT family —
  // mirrors addFamilyMember's invariant explicitly so the admin gets
  // a clear error message instead of a generic 500.
  const sourceFamily = await getFamilyForCustomer(customerId).catch(() => null);
  const targetFamily = await getFamilyForCustomer(targetAdult.id).catch(() => null);
  if (sourceFamily && targetFamily && sourceFamily.familyId !== targetFamily.familyId) {
    return bad(
      'This customer is already in a different family. Remove them from that family first.',
      'ALREADY_IN_FAMILY',
      409,
    );
  }
  if (sourceFamily && !targetFamily) {
    return bad(
      'This customer is already in a different family. Remove them from that family first.',
      'ALREADY_IN_FAMILY',
      409,
    );
  }

  // Pull display names from Square so the family card reads naturally.
  const sourceCustomer = await getCustomerById(customerId).catch(() => null);
  if (!sourceCustomer) {
    return bad('Source customerId not found in Square.', 'SOURCE_NOT_FOUND', 404);
  }
  const sourceDisplayName = resolveDisplayName(sourceCustomer, 'Member');
  const targetDisplayName = resolveDisplayName(targetAdult, 'Member');

  try {
    let familyId: string;
    let created = false;
    if (targetFamily) {
      familyId = targetFamily.familyId;
      // Quick caps check so the admin gets a clean 409 instead of a
      // generic 500 from addFamilyMember's internal cap.
      const memberCount = targetFamily.members.length;
      const adultCount = targetFamily.members.filter((m) => m.role === 'adult').length;
      if (memberCount >= MAX_FAMILY_MEMBERS) {
        return bad(
          `Family is at the ${MAX_FAMILY_MEMBERS}-member cap.`,
          'FAMILY_AT_CAP',
          409,
        );
      }
      if (role === 'adult' && adultCount >= MAX_FAMILY_ADULTS) {
        return bad(
          `Family is at the ${MAX_FAMILY_ADULTS}-adult cap.`,
          'FAMILY_AT_ADULT_CAP',
          409,
        );
      }
    } else {
      // Bootstrap a family with the target adult as founder.
      const newFamily = await createFamily({
        founderCustomerId: targetAdult.id,
        founderDisplayName: targetDisplayName,
      });
      familyId = newFamily.familyId;
      created = true;
    }

    // Already-a-member of THIS family? addFamilyMember is idempotent,
    // but we want to log it clearly.
    const alreadyMember =
      targetFamily?.members.some((m) => m.customerId === customerId) ?? false;

    const updated = await addFamilyMember(familyId, {
      customerId,
      role,
      displayName: sourceDisplayName,
    });

    logAdmin({
      phase: 'admin-family-add-member',
      customerId,
      familyId,
      targetAdultEmail,
      role,
      createdNewFamily: created,
      alreadyMember,
      membersAfter: updated.members.length,
    });

    return Response.json({
      ok: true,
      customerId,
      familyId,
      role,
      createdNewFamily: created,
      alreadyMember,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({
      phase: 'admin-family-add-member-failed',
      customerId,
      targetAdultEmail,
      role,
      detail,
    });
    return Response.json(
      { ok: false, error: { code: 'ADD_FAILED', detail } },
      { status: 502 },
    );
  }
};
