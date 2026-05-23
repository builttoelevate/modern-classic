// Short-lived signed session cookie for the admin pages. Parallel to
// barberSession.ts / session.ts: same HMAC-SHA256 signing, same
// AUTH_SECRET, distinct namespace marker ("admin") and cookie name
// ("mc_admin_session").
//
// Why this exists: the admin area authenticates with HTTP Basic Auth
// (checkBasicAuth). On iPhone Safari the browser reliably sends the
// Basic Auth header on top-level navigations but frequently does NOT
// re-attach it to background fetch() requests (the POST/DELETE the
// admin page buttons fire), so those actions get a 401 and fail with a
// confusing "Failed to ..." message. Cookies, unlike Basic Auth, ARE
// sent on same-origin fetch. So once an admin page loads via Basic
// Auth we mint this cookie; subsequent button actions authenticate via
// the cookie instead of relying on Safari to re-send the password.
//
// The cookie carries no identity (the admin password is a shared
// secret), just a signed "authenticated until exp" attestation. Kept
// short (12h) since it's a high-privilege credential.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE_NAME = 'mc_admin_session';
const ADMIN_NAMESPACE = 'admin';
const SECONDS_PER_HOUR = 3_600;
export const ADMIN_SESSION_DURATION_HOURS = 12;

interface SignedAdminSessionPayload {
  ns: typeof ADMIN_NAMESPACE;
  iat: number;
  exp: number;
}

function getSecret(): string {
  if (typeof window !== 'undefined') {
    throw new Error('Auth secret is server-only — refusing to read in browser context.');
  }
  const secret = import.meta.env.AUTH_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error('AUTH_SECRET is not set or too short. Generate one with `openssl rand -hex 32`.');
  }
  return secret;
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

const HEADER_B64 = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function hmacSign(input: string): string {
  const h = createHmac('sha256', getSecret());
  h.update(input);
  return base64UrlEncode(h.digest());
}

export function signAdminSession(
  durationHours: number = ADMIN_SESSION_DURATION_HOURS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SignedAdminSessionPayload = {
    ns: ADMIN_NAMESPACE,
    iat: now,
    exp: now + durationHours * SECONDS_PER_HOUR,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  return `${signingInput}.${hmacSign(signingInput)}`;
}

export function verifyAdminSession(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts;
  if (headerB64 !== HEADER_B64) return false;

  const expected = hmacSign(`${headerB64}.${payloadB64}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(sigB64);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const p = parsed as Partial<SignedAdminSessionPayload>;
  if (p.ns !== ADMIN_NAMESPACE) return false;
  if (typeof p.exp !== 'number' || typeof p.iat !== 'number') return false;
  if (p.exp <= Math.floor(Date.now() / 1000)) return false;

  return true;
}

export function buildAdminSessionCookie(token: string): string {
  const maxAge = ADMIN_SESSION_DURATION_HOURS * SECONDS_PER_HOUR;
  return formatSetCookie(ADMIN_SESSION_COOKIE_NAME, token, maxAge);
}

function formatSetCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function readAdminSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === ADMIN_SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}
