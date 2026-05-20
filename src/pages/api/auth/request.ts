import type { APIRoute } from 'astro';
import { signMagicToken } from '../../../lib/auth/magicLink';
import { isAuthConfigured } from '../../../lib/auth/session';
import { sendMagicLink } from '../../../lib/email/resend';
import {
  findCustomerByEmail,
  findCustomerByPhone,
} from '../../../lib/square/customers';
import { redactEmail } from '../../../lib/booking/log';
import { getPublicOrigin } from '../../../lib/utils/origin';

export const prerender = false;

const GENERIC_OK = {
  ok: true as const,
  message: 'If we found an account, we sent a sign-in link to your email.',
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
  // 7+ digits is enough to call something a phone number — most US shop
  // numbers are 10. Accept formatted variants like "(740) 297-4462".
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 16;
}


function logAuth(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[AUTH] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function redactPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
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

  // Accept either an explicit `email` / `phone` field OR a generic
  // `identifier` that we sniff. The form posts `identifier` so customers
  // can put either one in the same field.
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
          detail: `Please wait ${retryAfter}s before requesting another link.`,
        },
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }
  lastRequestedAt.set(rateKey, now);
  pruneRateLimitMap(now);

  // Find the customer (by whichever path applies), then send the magic
  // link to whatever email Square has on file. We DO surface a specific
  // 'no email on file' response when the user signed in by phone — that's
  // a real dead-end for them and the generic 'check your email' message
  // would be cruel. The phone path slightly weakens anti-enumeration but
  // phone numbers aren't trivially enumerable like emails are.
  try {
    const customer = isEmail
      ? await findCustomerByEmail(identifier)
      : await findCustomerByPhone(identifier);

    if (!customer) {
      logAuth({
        phase: 'no-customer-record',
        identifier: isEmail ? redactEmail(identifier) : redactPhone(identifier),
        method: isEmail ? 'email' : 'phone',
      });
      return Response.json(GENERIC_OK, { status: 200 });
    }

    const customerEmail = (customer.email_address ?? '').trim().toLowerCase();
    if (!customerEmail) {
      logAuth({
        phase: 'no-email-on-file',
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
              "We found your account but there's no email on file — sign-in links go by email. Please email modernclassicbarbershop@protonmail.com and we'll add one.",
          },
        },
        { status: 409 },
      );
    }

    const token = signMagicToken({ email: customerEmail });
    const origin = getPublicOrigin(request);
    const magicUrl = `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
    const customerName = customer.given_name?.trim();
    try {
      const result = await sendMagicLink({
        to: customerEmail,
        magicUrl,
        customerName: customerName || undefined,
      });
      logAuth({
        phase: 'magic-link-sent',
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
        phase: 'email-failed',
        email: redactEmail(customerEmail),
        method: isEmail ? 'email' : 'phone',
        detail,
        body: failBody,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAuth({
      phase: 'lookup-failed',
      identifier: isEmail ? redactEmail(identifier) : redactPhone(identifier),
      method: isEmail ? 'email' : 'phone',
      detail,
    });
  }

  return Response.json(GENERIC_OK, { status: 200 });
};
