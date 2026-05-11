// POST /api/family/create — first call in the family-account flow.
// Creates a family with the signed-in customer as the sole adult.
// Idempotent: a customer who already belongs to a family gets back
// their existing record (so a double-click from the /profile UI
// doesn't create a second family or 4xx).
//
// Optional name override: callers (the /profile UI) can pass
// `givenName` / `familyName` in the body to correct the founder's
// Square name at the same time the family is created. When the
// provided values differ from the existing Square record, we
// write-through via updateCustomer so the rename propagates to
// every surface that reads from Square (booking reminder texts,
// admin search, etc.) — not just the family card. Same pattern as
// /api/family/accept.

import type { APIRoute } from 'astro';
import {
  AuthRequiredError,
  requireSession,
  refreshSessionCookie,
} from '../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../lib/auth/session';
import { getCustomerById, updateCustomer } from '../../../lib/square/customers';
import { createFamily } from '../../../lib/customer/familyAccount';

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

  // Parse body — JSON is optional. If missing/invalid we fall through
  // to the no-override path. The body shape is { givenName?, familyName? }.
  let bodyGivenName: string | undefined;
  let bodyFamilyName: string | undefined;
  try {
    const raw = await request.text();
    if (raw && raw.length > 0) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.givenName === 'string') bodyGivenName = parsed.givenName.trim();
      if (typeof parsed.familyName === 'string') bodyFamilyName = parsed.familyName.trim();
    }
  } catch {
    // Non-JSON body or empty — proceed without override.
  }

  // Resolve the founder's name. Priority: explicit body override
  // (write-through to Square when it differs) > current Square value
  // > session-email local part.
  let founderName = session.email.split('@')[0] ?? 'Customer';
  let nameUpdated = false;
  try {
    const existing = await getCustomerById(session.customerId);
    const currentGiven = (existing?.given_name ?? '').trim();
    const currentFamily = (existing?.family_name ?? '').trim();
    const wantGiven = bodyGivenName !== undefined ? bodyGivenName : currentGiven;
    const wantFamily = bodyFamilyName !== undefined ? bodyFamilyName : currentFamily;

    // Reject blank-after-trim overrides — better to fall through to
    // the existing name than save a record with empty given_name.
    const haveOverride =
      (bodyGivenName !== undefined && bodyGivenName.length > 0 &&
        bodyGivenName !== currentGiven) ||
      (bodyFamilyName !== undefined && bodyFamilyName.length > 0 &&
        bodyFamilyName !== currentFamily);

    if (existing && haveOverride && wantGiven.length > 0) {
      try {
        const updated = await updateCustomer(session.customerId, {
          givenName: wantGiven,
          familyName: wantFamily,
        });
        nameUpdated = true;
        const full = `${updated.given_name ?? ''} ${updated.family_name ?? ''}`.trim();
        if (full) founderName = full;
      } catch (updateErr) {
        // Non-fatal — fall back to existing Square name. Family
        // creation still proceeds with whatever name Square has.
        logFamily({
          phase: 'family-create-name-write-failed',
          founderCustomerId: session.customerId,
          detail: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
        const full = `${currentGiven} ${currentFamily}`.trim();
        if (full) founderName = full;
      }
    } else if (existing) {
      const full = `${currentGiven} ${currentFamily}`.trim();
      if (full) founderName = full;
    }
  } catch {
    // getCustomerById hiccup — fall back to email local-part.
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
      nameUpdated,
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
    return fail(500, 'INTERNAL', detail);
  }
};
