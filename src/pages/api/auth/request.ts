import type { APIRoute } from 'astro';
import { signMagicToken } from '../../../lib/auth/magicLink';
import { isAuthConfigured } from '../../../lib/auth/session';
import { sendMagicLink } from '../../../lib/email/resend';
import { findCustomerByEmail } from '../../../lib/square/customers';
import { redactEmail } from '../../../lib/booking/log';

export const prerender = false;

const GENERIC_OK = {
  ok: true as const,
  message: 'If we found an account, we sent a sign-in link to your email.',
};

const RATE_LIMIT_SECONDS = 60;
const lastRequestedAt = new Map<string, number>();

function pruneRateLimitMap(now: number): void {
  if (lastRequestedAt.size < 1024) return;
  for (const [email, ts] of lastRequestedAt) {
    if (now - ts > RATE_LIMIT_SECONDS * 1000) lastRequestedAt.delete(email);
  }
}

function isValidEmail(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  return /^\S+@\S+\.\S+$/.test(s.trim());
}

function siteOriginFromRequest(request: Request): string {
  const env = import.meta.env.SITE_URL;
  if (typeof env === 'string' && /^https?:\/\//i.test(env)) {
    return env.replace(/\/$/, '');
  }
  // Vercel passes the deployment host; honor x-forwarded headers.
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  // Fallback to URL parsed from the request.
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`.replace(/\/$/, '');
  } catch {
    return 'https://mdrnclassic.com';
  }
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
  const email = (body as { email?: unknown })?.email;
  if (!isValidEmail(email)) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'A valid email is required.' } },
      { status: 400 },
    );
  }

  const normalized = email.trim().toLowerCase();
  const now = Date.now();
  const last = lastRequestedAt.get(normalized);
  if (last && now - last < RATE_LIMIT_SECONDS * 1000) {
    const retryAfter = Math.ceil((RATE_LIMIT_SECONDS * 1000 - (now - last)) / 1000);
    logAuth({ phase: 'rate-limited', email: redactEmail(normalized), retryAfter });
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
  lastRequestedAt.set(normalized, now);
  pruneRateLimitMap(now);

  // Always return the same response shape — anti-enumeration. Send the
  // email asynchronously after we know the customer exists.
  try {
    const customer = await findCustomerByEmail(normalized);
    if (customer) {
      const token = signMagicToken({ email: normalized });
      const origin = siteOriginFromRequest(request);
      const magicUrl = `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
      const customerName = customer.given_name?.trim();
      try {
        const result = await sendMagicLink({
          to: normalized,
          magicUrl,
          customerName: customerName || undefined,
        });
        logAuth({
          phase: 'magic-link-sent',
          email: redactEmail(normalized),
          messageId: result.id,
        });
      } catch (err) {
        // Email failure is the only reason to surface a 5xx, but we
        // still don't reveal whether the email exists. Log and pretend
        // it worked — the user will retry if no email arrives. Phase 6
        // can wire alerting.
        const detail = err instanceof Error ? err.message : String(err);
        const body =
          err && typeof err === 'object' && 'body' in err && typeof (err as { body?: unknown }).body === 'string'
            ? (err as { body: string }).body
            : undefined;
        logAuth({ phase: 'email-failed', email: redactEmail(normalized), detail, body });
      }
    } else {
      logAuth({ phase: 'no-customer-record', email: redactEmail(normalized) });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAuth({ phase: 'lookup-failed', email: redactEmail(normalized), detail });
    // Fall through to the generic-ok response. We don't want lookup
    // errors to leak whether the address is registered.
  }

  return Response.json(GENERIC_OK, { status: 200 });
};
