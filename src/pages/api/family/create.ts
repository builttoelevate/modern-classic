// POST /api/family/create — first call in the family-account flow.
// Creates a family with the signed-in customer as the sole adult.
// Idempotent: a customer who already belongs to a family gets back
// their existing record (so a double-click from the /profile UI
// doesn't create a second family or 4xx).

import type { APIRoute } from 'astro';
import {
  AuthRequiredError,
  requireSession,
  refreshSessionCookie,
} from '../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../lib/auth/session';
import { getCustomerById } from '../../../lib/square/customers';
import { createFamily } from '../../../lib/customer/familyAccount';

export const prerender = false;

function logFamily(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[FAMILY] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAuthConfigured()) {
    return Response.json(
      { ok: false, error: { code: 'AUTH_NOT_CONFIGURED', detail: 'Auth not configured.' } },
      { status: 503 },
    );
  }

  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }

  // Need the customer's Square name for the founder member entry —
  // the family member list renders "Bill (Spouse)" etc., and "Bill"
  // comes from the Square given_name. Falls back to the session
  // email's local part if the Square lookup fails.
  let founderName = session.email.split('@')[0] ?? 'Customer';
  try {
    const customer = await getCustomerById(session.customerId);
    if (customer) {
      const full = `${customer.given_name ?? ''} ${customer.family_name ?? ''}`.trim();
      if (full) founderName = full;
    }
  } catch {
    // Fall back to email local-part. Non-fatal.
  }

  try {
    const family = await createFamily({
      founderCustomerId: session.customerId,
      founderDisplayName: founderName,
    });
    logFamily({
      phase: 'family-created',
      familyId: family.familyId,
      founderCustomerId: session.customerId,
      memberCount: family.members.length,
    });
    return new Response(JSON.stringify({ ok: true, family }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshSessionCookie(session),
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logFamily({
      phase: 'family-create-failed',
      founderCustomerId: session.customerId,
      detail,
    });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }
};
