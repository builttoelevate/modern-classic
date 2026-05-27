// Admin-only manual waitlist add. Lets staff put a walk-in / phone-in
// onto the waitlist without the public booking-flow sheet. Mirrors the
// validation in /api/waitlist but: email is OPTIONAL (phone-only walk-
// ins are allowed — they just won't get the auto-notify email, staff
// text/call those), and it sends NO customer confirmation email.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import { recordWaitlistEntry } from '../../../../lib/marketing/waitlistLog';

export const prerender = false;

function badRequest(detail: string, status = 400): Response {
  return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail } }, { status });
}

function isValidEmail(s: string): boolean {
  return /^\S+@\S+\.\S+$/.test(s.trim());
}

function isValidPhone(s: string): boolean {
  const d = s.replace(/[^0-9]/g, '');
  return d.length >= 7 && d.length <= 16;
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be valid JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const serviceName = typeof b.serviceName === 'string' ? b.serviceName.trim() : '';
  const barberName = typeof b.barberName === 'string' ? b.barberName.trim() : '';
  const serviceVariationId =
    typeof b.serviceVariationId === 'string' && b.serviceVariationId.trim()
      ? b.serviceVariationId.trim()
      : null;
  const teamMemberId =
    typeof b.teamMemberId === 'string' && b.teamMemberId.trim() ? b.teamMemberId.trim() : null;
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 600) : undefined;

  if (!name) return badRequest('Customer name is required.');
  if (!isValidPhone(phone)) return badRequest('A valid phone number is required.');
  if (email && !isValidEmail(email)) return badRequest('That email address looks invalid.');
  if (!serviceName) return badRequest('A service is required.');
  if (!barberName) return badRequest('A barber is required (or pick "Any barber").');

  try {
    const entry = await recordWaitlistEntry({
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      serviceName,
      barberName,
      serviceVariationId,
      teamMemberId,
      note: note || undefined,
    });
    return Response.json({ ok: true, entry });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    // eslint-disable-next-line no-console
    console.log(
      `[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), phase: 'waitlist-manual-add-failed', detail })}`,
    );
    return Response.json({ ok: false, error: { code: 'INTERNAL', detail } }, { status: 500 });
  }
};
