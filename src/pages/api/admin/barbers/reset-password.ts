import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getAccount,
  updateAccountPassword,
} from '../../../../lib/barber/accountStore';
import { generateDefaultPassword, hashPassword } from '../../../../lib/auth/passwordHash';
import { resolveBarberContact } from '../../../../lib/barber/contactLookup';
import { sendPasswordResetBarber } from '../../../../lib/email/resend';
import { getPublicOrigin } from '../../../../lib/utils/origin';

export const prerender = false;

const SHOP_PHONE = '740-297-4462';

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

// Admin resets a barber's password. By default generates a fresh
// random 10-char password and returns the plaintext once so the
// admin page can show it for the admin to text out-of-band. The
// admin can also supply a custom password in the body — useful when
// the admin wants something memorable to text the barber, or when
// they're standing next to the barber and just want to set it
// together. Either way, mustChangePassword flips back on so the
// barber is prompted to set their own on next login.

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
  const b = (body ?? {}) as Record<string, unknown>;
  const teamMemberId = typeof b.teamMemberId === 'string' ? b.teamMemberId.trim() : '';
  if (!teamMemberId) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'teamMemberId is required.' } },
      { status: 400 },
    );
  }

  // Optional admin-supplied password. When provided, we use it
  // verbatim (after light validation); when omitted, generate a
  // random one as before.
  const rawPassword = typeof b.password === 'string' ? b.password : null;
  if (rawPassword !== null) {
    if (rawPassword.length < 8) {
      return Response.json(
        { ok: false, error: { code: 'BAD_REQUEST', detail: 'Password must be at least 8 characters.' } },
        { status: 400 },
      );
    }
    if (rawPassword.length > 128) {
      return Response.json(
        { ok: false, error: { code: 'BAD_REQUEST', detail: 'Password is too long.' } },
        { status: 400 },
      );
    }
  }

  const existing = await getAccount(teamMemberId);
  if (!existing) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'No account for that team member.' } },
      { status: 404 },
    );
  }

  const plaintext = rawPassword ?? generateDefaultPassword(10);
  const wasGenerated = rawPassword === null;
  const hash = await hashPassword(plaintext);
  await updateAccountPassword(teamMemberId, hash, true);

  // Security notification — let the barber know their password was
  // reset so they can flag it if they didn't expect it. We never mail
  // the plaintext; Michael hands that over by text out-of-band. Skip
  // silently if we can't resolve an inbox (the barber's account email
  // and Square email_address are both empty).
  try {
    const contact = await resolveBarberContact(teamMemberId);
    if (contact) {
      const origin = getPublicOrigin(request);
      const send = await sendPasswordResetBarber({
        to: contact.email,
        barberDisplayName: contact.displayName,
        username: existing.username,
        signInUrl: `${origin}/barber/sign-in`,
        shopPhone: SHOP_PHONE,
      });
      logAdmin({
        phase: 'barber-password-reset-notify-sent',
        teamMemberId,
        resendId: send.id,
      });
    } else {
      logAdmin({
        phase: 'barber-password-reset-notify-skipped-no-email',
        teamMemberId,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({
      phase: 'barber-password-reset-notify-failed',
      teamMemberId,
      detail,
    });
  }

  return Response.json({
    ok: true,
    teamMemberId,
    username: existing.username,
    generatedPassword: plaintext,
    /** True when the server generated the password; false when the
     *  admin supplied it. The UI only needs to show the plaintext
     *  back when generated — the admin already knows the value they
     *  typed. */
    wasGenerated,
  });
};
