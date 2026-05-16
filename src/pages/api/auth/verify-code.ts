// POST /api/auth/verify-code — validates the 6-digit code the
// customer typed, looks up their Square customer record, and sets
// the same mc_session cookie the magic-link flow sets. Cookie lands
// in WHATEVER browser the customer was using when they typed the
// code, which is the whole point.

import type { APIRoute } from 'astro';
import { buildSessionCookie, isAuthConfigured, signSession } from '../../../lib/auth/session';
import { verifyCode } from '../../../lib/auth/otpStore';
import { findCustomerByEmail } from '../../../lib/square/customers';
import { redactEmail } from '../../../lib/booking/log';

export const prerender = false;

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
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  if (!email || !code) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'email and code are required.' } },
      { status: 400 },
    );
  }
  // Only allow 6 numeric digits — no whitespace, no dashes, no
  // letters. Reject early so brute-force attempts don't burn through
  // attempts with junk input.
  if (!/^\d{6}$/.test(code)) {
    return Response.json(
      { ok: false, error: { code: 'BAD_CODE', detail: 'Code must be 6 digits.' } },
      { status: 400 },
    );
  }

  let outcome;
  try {
    outcome = await verifyCode(email, code);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAuth({ phase: 'otp-verify-store-failed', email: redactEmail(email), detail });
    return Response.json(
      {
        ok: false,
        error: {
          code: 'STORE_UNAVAILABLE',
          detail: "We're having trouble verifying right now. Please try again in a moment.",
        },
      },
      { status: 502 },
    );
  }
  if (!outcome.ok) {
    if (outcome.reason === 'expired') {
      logAuth({ phase: 'otp-verify-expired', email: redactEmail(email) });
      return Response.json(
        {
          ok: false,
          error: {
            code: 'CODE_EXPIRED',
            detail: "That code has expired. Request a new one.",
          },
        },
        { status: 410 },
      );
    }
    if (outcome.reason === 'locked') {
      logAuth({ phase: 'otp-verify-locked', email: redactEmail(email) });
      return Response.json(
        {
          ok: false,
          error: {
            code: 'CODE_LOCKED',
            detail: 'Too many attempts. Request a new code.',
          },
        },
        { status: 429 },
      );
    }
    // mismatch
    logAuth({
      phase: 'otp-verify-mismatch',
      email: redactEmail(email),
      attemptsLeft: outcome.attemptsLeft,
    });
    return Response.json(
      {
        ok: false,
        error: {
          code: 'CODE_INCORRECT',
          detail:
            outcome.attemptsLeft === 1
              ? "That code didn't match. One attempt left before you'll need a new code."
              : `That code didn't match. ${outcome.attemptsLeft} attempts left.`,
        },
      },
      { status: 401 },
    );
  }

  // Code was correct. Look up the customer to mint the session.
  let customerId: string | null = null;
  try {
    const customer = await findCustomerByEmail(email);
    if (customer) customerId = customer.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAuth({ phase: 'otp-verify-customer-lookup-failed', email: redactEmail(email), detail });
  }

  if (!customerId) {
    // Customer existed at request-code time (or we wouldn't have
    // generated a code), but Square is unreachable now. Fail with a
    // clear retry message rather than a half-set session.
    return Response.json(
      {
        ok: false,
        error: {
          code: 'SESSION_FAILED',
          detail: 'Your code was right, but we couldn\'t finish signing you in. Try again in a moment.',
        },
      },
      { status: 502 },
    );
  }

  const token = signSession({ customerId, email });
  logAuth({ phase: 'otp-verify-success', email: redactEmail(email), customerId });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildSessionCookie(token),
    },
  });
};
