// POST /api/family/leave — removes the signed-in customer from
// their family. Three terminal cases:
//   - Not in a family: 409 NOT_IN_FAMILY
//   - Was a member, others remain: family stays, caller is removed
//   - Was the last adult: removeFamilyMember dissolves the family
//
// We don't touch any existing legacy parent→kid links here — those
// are stored under a separate Redis namespace (mc:profile:kids) and
// keep working unchanged after leaving. The /my-bookings read path
// (PR 2) falls back to that legacy model when no family is found
// for the session customer.

import type { APIRoute } from 'astro';
import {
  AuthRequiredError,
  requireSession,
  refreshSessionCookie,
} from '../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../lib/auth/session';
import {
  getFamilyForCustomer,
  removeFamilyMember,
} from '../../../lib/customer/familyAccount';

export const prerender = false;

function logFamily(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[FAMILY] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAuthConfigured()) {
    return fail(503, 'AUTH_NOT_CONFIGURED', 'Auth not configured.');
  }

  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }

  const family = await getFamilyForCustomer(session.customerId);
  if (!family) {
    return fail(409, 'NOT_IN_FAMILY', "You aren't in a family right now.");
  }

  try {
    const updated = await removeFamilyMember(family.familyId, session.customerId);
    const dissolved = updated === null;
    logFamily({
      phase: 'family-member-left',
      familyId: family.familyId,
      leavingCustomerId: session.customerId,
      dissolved,
      remainingMembers: updated?.members.length ?? 0,
    });
    return new Response(
      JSON.stringify({ ok: true, dissolved, family: updated }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logFamily({
      phase: 'family-leave-failed',
      familyId: family.familyId,
      leavingCustomerId: session.customerId,
      detail,
    });
    return fail(500, 'INTERNAL', detail);
  }
};
