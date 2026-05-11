// Admin one-shot: dissolve a family entirely.
//
// Hard nuke — drops the family record and every member→family
// pointer. Customers fall back to the legacy listLinkedPeople /
// solo path on their next /my-bookings render. Used when a family
// got created wrong (test family, wrong wife joined the wrong
// husband, duplicate family by a race) and the admin just wants
// it gone.
//
// Does NOT touch Square bookings, customer records, or
// linkedPeople kids — purely the family graph.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { dissolveFamily, getFamilyById } from '../../../../lib/customer/familyAccount';

export const prerender = false;

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

interface RequestBody {
  familyId?: string;
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
  const familyId = typeof b.familyId === 'string' ? b.familyId.trim() : '';
  if (!familyId) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'familyId is required.' } },
      { status: 400 },
    );
  }

  // Snapshot member list before dissolve so the log line records
  // who got freed.
  const before = await getFamilyById(familyId).catch(() => null);
  if (!before) {
    return Response.json({ ok: true, familyId, dissolved: false, alreadyGone: true });
  }

  try {
    const dissolved = await dissolveFamily(familyId);
    logAdmin({
      phase: 'admin-family-dissolve',
      familyId,
      dissolved,
      memberCount: before.members.length,
      memberCustomerIds: before.members.map((m) => m.customerId),
    });
    return Response.json({ ok: true, familyId, dissolved, alreadyGone: false });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({ phase: 'admin-family-dissolve-failed', familyId, detail });
    return Response.json(
      { ok: false, error: { code: 'DISSOLVE_FAILED', detail } },
      { status: 502 },
    );
  }
};
