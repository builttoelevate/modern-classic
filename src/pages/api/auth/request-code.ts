// POST /api/auth/request-code — sends a 6-digit sign-in code to the
// email matched by the customer's input (email OR phone). Mirrors
// the existing /api/auth/request magic-link flow's anti-enumeration,
// rate-limit, and "no email on file" semantics — only difference is
// what gets emailed.
//
// Why this exists: see src/lib/auth/otpStore.ts. tl;dr — magic
// links fail for users whose email app opens links in an isolated
// in-app browser (iOS ProtonMail). A typed code never has that
// cross-browser handoff problem.

import type { APIRoute } from 'astro';
import { isAuthConfigured } from '../../../lib/auth/session';
import { OTP_TTL_SECONDS, requestCode } from '../../../lib/auth/otpStore';
import { sendAuthCode } from '../../../lib/email/resend';
import {
  findCustomerByEmail,
  findCustomerByPhone,
} from '../../../lib/square/customers';
import { redactEmail } from '../../../lib/booking/log';
import { SHOP_PHONE } from '../../../lib/branding';

export const prerender = false;

// Generic response: never reveal whether an email/phone matched a
// customer. The customer either sees "check your email" or — only
// on the phone-lookup path with no email on Square — a specific
// "no email on file" message they need to act on (call the shop).
const GENERIC_OK = {
  ok: true as const,
  message: 'If we found an account, we sent a sign-in code to your email.',
};

const RATE_LIMIT_SECONDS = 60;
const lastRequestedAt = new Map<string, number>();

function pruneRateLimitMap(now: number): void {
  if (lastRequestedAt.size < 1024) return;
  for (const [k, ts] of lastRequestedAt) {
    if (now - ts > RATE_LIMIT_SECONDS * 1000) lastRequestedAt.delete(k);
  }
}

function looksLikeEmail(s: string): boolean {
  return /^\S+@\S+\.\S+$/.test(s.trim());
}

function looksLikePhone(s: string): boolean {
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 16;
}

function redactPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

function logAuth(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[AUTH] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAuthConfigured()) {
    return Response.json(
      { ok: false, error: { code: 'AUTH_NOT_CONFIGURED', detail: 'Auth not configured.' } },
      { status: 503 },
    );
  }

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
  const rawEmail = typeof b.email === 'string' ? b.email : '';
  const rawPhone = typeof b.phone === 'string' ? b.phone : '';
  const rawIdentifier = typeof b.identifier === 'string' ? b.identifier : '';
  const identifier = (rawEmail || rawPhone || rawIdentifier).trim();

  if (!identifier) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          detail: 'Enter the email or phone number you used to book.',
        },
      },
      { status: 400 },
    );
  }

  const isEmail = rawEmail || (!rawPhone && looksLikeEmail(identifier));
  const isPhone = !isEmail && (rawPhone || looksLikePhone(identifier));

  if (!isEmail && !isPhone) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          detail: 'That doesn\'t look like an email or a phone number.',
        },
      },
      { status: 400 },
    );
  }

  const rateKey = isEmail
    ? `e:${identifier.toLowerCase()}`
    : `p:${identifier.replace(/[^0-9]/g, '').slice(-10)}`;
  const now = Date.now();
  const last = lastRequestedAt.get(rateKey);
  if (last && now - last < RATE_LIMIT_SECONDS * 1000) {
    const retryAfter = Math.ceil((RATE_LIMIT_SECONDS * 1000 - (now - last)) / 1000);
    return Response.json(
      {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          detail: `Please wait ${retryAfter}s before requesting another code.`,
        },
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }
  lastRequestedAt.set(rateKey, now);
  pruneRateLimitMap(now);

  try {
    const customer = isEmail
      ? await findCustomerByEmail(identifier)
      : await findCustomerByPhone(identifier);

    if (!customer) {
      logAuth({
        phase: 'otp-no-customer-record',
        identifier: isEmail ? redactEmail(identifier) : redactPhone(identifier),
        method: isEmail ? 'email' : 'phone',
      });
      return Response.json(GENERIC_OK, { status: 200 });
    }

    const customerEmail = (customer.email_address ?? '').trim().toLowerCase();
    if (!customerEmail) {
      logAuth({
        phase: 'otp-no-email-on-file',
        identifier: isEmail ? redactEmail(identifier) : redactPhone(identifier),
        method: isEmail ? 'email' : 'phone',
        customerId: customer.id,
      });
      return Response.json(
        {
          ok: false,
          error: {
            code: 'NO_EMAIL_ON_FILE',
            detail:
              "We found your account but there's no email on file — sign-in codes go by email. Please call the shop and we'll add one in a minute.",
          },
        },
        { status: 409 },
      );
    }

    const { code } = await requestCode(customerEmail);
    try {
      const result = await sendAuthCode({
        to: customerEmail,
        code,
        ttlMinutes: Math.floor(OTP_TTL_SECONDS / 60),
        customerName: customer.given_name?.trim() || undefined,
        shopPhone: SHOP_PHONE,
      });
      logAuth({
        phase: 'otp-requested',
        email: redactEmail(customerEmail),
        method: isEmail ? 'email' : 'phone',
        messageId: result.id,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const failBody =
        err && typeof err === 'object' && 'body' in err && typeof (err as { body?: unknown }).body === 'string'
          ? (err as { body: string }).body
          : undefined;
      logAuth({
        phase: 'otp-email-failed',
        email: redactEmail(customerEmail),
        method: isEmail ? 'email' : 'phone',
        detail,
        body: failBody,
      });
      // Don't reveal the Resend failure to the client — they'd think
      // their email was wrong. Same generic OK; they'll retry in 60s
      // and the next attempt should succeed.
    }

    // Return the (lowercased) email so the client can show it on the
    // "enter your code" step AND submit it to /api/auth/verify-code.
    return Response.json({ ...GENERIC_OK, email: customerEmail }, { status: 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAuth({
      phase: 'otp-lookup-failed',
      identifier: isEmail ? redactEmail(identifier) : redactPhone(identifier),
      method: isEmail ? 'email' : 'phone',
      detail,
    });
  }

  return Response.json(GENERIC_OK, { status: 200 });
};
