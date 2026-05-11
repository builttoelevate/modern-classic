// POST /api/family/invite — sends a family invite email to an
// adult by email address.
//
// Caller must already be in a family (we don't auto-create here so
// the UI flow stays predictable: Create → see family → Invite).
// Invite is bound to the invitee's email, gets a 7-day TTL, and is
// single-use (consumed on accept).

import type { APIRoute } from 'astro';
import {
  AuthRequiredError,
  requireSession,
  refreshSessionCookie,
} from '../../../lib/auth/middleware';
import { isAuthConfigured } from '../../../lib/auth/session';
import { getCustomerById } from '../../../lib/square/customers';
import {
  createInvite,
  getFamilyForCustomer,
  MAX_FAMILY_ADULTS,
  MAX_FAMILY_MEMBERS,
} from '../../../lib/customer/familyAccount';
import { sendFamilyInvite } from '../../../lib/email/resend';
import { redactEmail } from '../../../lib/booking/log';

export const prerender = false;

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';

function logFamily(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[FAMILY] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

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

function formatExpiresLabel(expiresAtIso: string): string {
  const date = new Date(expiresAtIso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
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
  const invitedEmailRaw = typeof b.inviteeEmail === 'string' ? b.inviteeEmail.trim() : '';
  if (!invitedEmailRaw) return fail(400, 'BAD_REQUEST', "Invitee email is required.");
  if (!/^\S+@\S+\.\S+$/.test(invitedEmailRaw)) {
    return fail(400, 'BAD_REQUEST', 'Invitee email is not in a valid format.');
  }
  const invitedEmail = invitedEmailRaw.toLowerCase();
  if (invitedEmail === session.email.toLowerCase()) {
    return fail(400, 'BAD_REQUEST', "You can't invite yourself.");
  }

  const family = await getFamilyForCustomer(session.customerId);
  if (!family) {
    return fail(
      400,
      'NO_FAMILY',
      'Create a family first before inviting someone.',
    );
  }

  // Cap checks before generating the token + sending mail so we
  // don't dangle a useless invite the invitee can't accept anyway.
  if (family.members.length >= MAX_FAMILY_MEMBERS) {
    return fail(409, 'AT_CAP', `Family is at the ${MAX_FAMILY_MEMBERS}-member cap.`);
  }
  const adultCount = family.members.filter((m) => m.role === 'adult').length;
  if (adultCount >= MAX_FAMILY_ADULTS) {
    return fail(
      409,
      'ADULT_CAP',
      `Family is at the ${MAX_FAMILY_ADULTS}-adult cap.`,
    );
  }

  // Inviter display name — used in the email subject + body.
  let inviterName = session.email.split('@')[0] ?? 'A customer';
  try {
    const inviter = await getCustomerById(session.customerId);
    if (inviter) {
      const first = (inviter.given_name ?? '').trim();
      if (first) inviterName = first;
    }
  } catch {
    // Fall back to local-part. Non-fatal.
  }

  const { token, record } = await createInvite({
    familyId: family.familyId,
    invitedEmail,
    invitedByCustomerId: session.customerId,
  });

  const origin = siteOriginFromRequest(request);
  const acceptUrl = `${origin}/family/accept?token=${encodeURIComponent(token)}`;
  const expiresLabel = `by ${formatExpiresLabel(record.expiresAt)}`;

  try {
    const result = await sendFamilyInvite({
      to: invitedEmail,
      inviterName,
      acceptUrl,
      expiresLabel,
      shopAddress: SHOP_ADDRESS,
      shopPhone: SHOP_PHONE,
    });
    logFamily({
      phase: 'family-invite-sent',
      familyId: family.familyId,
      invitedEmail: redactEmail(invitedEmail),
      messageId: result.id,
    });
    return new Response(
      JSON.stringify({ ok: true, expiresAt: record.expiresAt }),
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
      phase: 'family-invite-send-failed',
      familyId: family.familyId,
      invitedEmail: redactEmail(invitedEmail),
      detail,
    });
    return fail(502, 'EMAIL_FAILED', "Couldn't send the invite email.");
  }
};
