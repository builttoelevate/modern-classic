// GET /api/admin/blocks/check?phone=... — admin-only inspection.
//
// Used by the /admin/blocks page's "Check a phone" mini-form so the
// operator can sanity-check whether a number is on the list without
// having to scan the full table. Server-side phone normalization
// means the operator can paste anything that looks like a phone.
//
// This endpoint MUST stay admin-auth-only — never proxy it to public.
// Knowing whether a phone is blocked is sensitive operator info.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  isPhoneBlocked,
  listBlockedEntries,
  type BlockedEntry,
} from '../../../../lib/customer/blockedCustomers';
import { normalizePhone } from '../../../../lib/phone';

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;
  const raw = (url.searchParams.get('phone') ?? '').trim();
  if (!raw) {
    return Response.json(
      { ok: false, error: { detail: 'phone query param is required.' } },
      { status: 400 },
    );
  }
  try {
    const blocked = await isPhoneBlocked(raw);
    if (!blocked) {
      return Response.json(
        { ok: true, blocked: false, phoneNormalized: normalizePhone(raw) },
        { status: 200 },
      );
    }
    // Find the entry so the admin UI can show the date / reason.
    // listBlockedEntries is cheap (~50 entries lifetime).
    const e164 = normalizePhone(raw);
    const all = await listBlockedEntries();
    const entry: BlockedEntry | undefined = all.find((e) => e.phone === e164);
    return Response.json(
      { ok: true, blocked: true, phoneNormalized: e164, entry: entry ?? null },
      { status: 200 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, error: { detail } }, { status: 500 });
  }
};
