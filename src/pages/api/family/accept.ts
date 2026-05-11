// POST /api/family/accept — consumes a family invite token and
// adds the signed-in customer to the family as an adult.
//
// Email-binding: the invite is bound to the invitee's email at
// generate time; we refuse acceptance unless the session's email
// matches. Stops a leaked token from being used by someone other
// than the intended invitee.
//
// Token is single-use — consumeInvite deletes on read, so a
// double-tap on Accept returns the "already accepted" code on the
// second pass instead of double-adding.

import type { APIRoute } from 'astro';
import {
  AuthRequiredError,
  requireSession,
  refreshSessionCookie,
} from '../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../lib/auth/session';
import { getCustomerById } from '../../../lib/square/customers';
import {
  addFamilyMember,
  consumeInvite,
  getFamilyById,
  getFamilyForCustomer,
} from '../../../lib/customer/familyAccount';
import { sendFamilyInviteAccepted } from '../../../lib/email/resend';
import { redactEmail } from '../../../lib/booking/log';

export const prerender = false;

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';

function siteOriginFromRequest(request: Request): string {
  const env = import.meta.env.SITE_URL;
  if (typeof env === 'string' && /^https?:\/\//i.test(env)) {
    return env.replace(/\/$/, '');
  }
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`.replace(/\/$/, '');
  } catch {
    return 'https://mdrnclassic.com';
  }
}

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (!token) return fail(400, 'BAD_REQUEST', 'token is required.');

  // Peek before consume so we can refuse on email-mismatch without
  // destroying the token. If it's expired, redis already evicted it.
  const sessionEmail = session.email.trim().toLowerCase();

  // Already a member of this family? Double-tap protection. Look
  // before consuming so the second tap doesn't get a confusing
  // "invite not found" error.
  const existingFamily = await getFamilyForCustomer(session.customerId);

  const record = await consumeInvite(token);
  if (!record) {
    // Token gone — either expired, already used, or bogus. If the
    // session is already in the family the token pointed at, that's
    // a benign double-accept; surface it as ok.
    if (existingFamily) {
      return Response.json(
        { ok: true, family: existingFamily, alreadyMember: true },
        { headers: { 'Set-Cookie': refreshSessionCookie(session) } },
      );
    }
    return fail(404, 'INVITE_NOT_FOUND', 'This invite has expired or already been used.');
  }

  if (record.invitedEmail !== sessionEmail) {
    return fail(
      403,
      'EMAIL_MISMATCH',
      'This invite is for a different email. Sign in with the email it was sent to.',
    );
  }

  // Make sure the inviting family still exists (the inviter could
  // have dissolved it between invite + accept).
  const family = await getFamilyById(record.familyId);
  if (!family) {
    return fail(410, 'FAMILY_GONE', 'That family no longer exists.');
  }

  // If the session is already in a different family, refuse — they
  // need to leave their current one first.
  if (existingFamily && existingFamily.familyId !== record.familyId) {
    return fail(
      409,
      'ALREADY_IN_FAMILY',
      "You're already in a different family. Leave it first before accepting.",
    );
  }

  // Pull the customer's display name for the new member entry.
  let displayName = sessionEmail.split('@')[0] ?? 'Member';
  try {
    const customer = await getCustomerById(session.customerId);
    if (customer) {
      const full = `${customer.given_name ?? ''} ${customer.family_name ?? ''}`.trim();
      if (full) displayName = full;
    }
  } catch {
    // Fall back. Non-fatal.
  }

  try {
    const updated = await addFamilyMember(record.familyId, {
      customerId: session.customerId,
      role: 'adult',
      displayName,
    });
    logFamily({
      phase: 'family-invite-accepted',
      familyId: record.familyId,
      invitedByCustomerId: record.invitedByCustomerId,
      acceptedByCustomerId: session.customerId,
      memberCount: updated.members.length,
    });

    // Best-effort notification to the inviter. Wrapped in its own
    // try/catch so a Resend hiccup, missing inviter email, or
    // deleted-inviter-record never fails the accept itself — the
    // family link is the primary contract, the email is a courtesy.
    try {
      const inviter = await getCustomerById(record.invitedByCustomerId);
      const inviterEmail = inviter?.email_address?.trim();
      if (inviterEmail) {
        const inviterName =
          `${inviter?.given_name ?? ''} ${inviter?.family_name ?? ''}`.trim() ||
          inviterEmail.split('@')[0] ||
          'there';
        const origin = siteOriginFromRequest(request);
        const result = await sendFamilyInviteAccepted({
          to: inviterEmail,
          inviterName,
          acceptedByName: displayName,
          totalMembers: updated.members.length,
          myBookingsUrl: `${origin}/my-bookings`,
          shopAddress: SHOP_ADDRESS,
          shopPhone: SHOP_PHONE,
        });
        logFamily({
          phase: 'family-invite-accepted-notify-sent',
          familyId: record.familyId,
          inviterEmail: redactEmail(inviterEmail),
          messageId: result.id,
        });
      } else {
        logFamily({
          phase: 'family-invite-accepted-notify-skipped',
          familyId: record.familyId,
          reason: 'no-inviter-email',
          invitedByCustomerId: record.invitedByCustomerId,
        });
      }
    } catch (notifyErr) {
      logFamily({
        phase: 'family-invite-accepted-notify-failed',
        familyId: record.familyId,
        detail: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      });
    }

    return new Response(
      JSON.stringify({ ok: true, family: updated, alreadyMember: false }),
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
      phase: 'family-invite-accept-failed',
      familyId: record.familyId,
      acceptedByCustomerId: session.customerId,
      detail,
    });
    return fail(500, 'INTERNAL', detail);
  }
};
