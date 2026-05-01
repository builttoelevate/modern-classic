// Phase 5 Part A — session cookies for the customer portal.
//
// Token format is JWT-shaped (header.payload.signature, base64url) but we
// roll our own HMAC-SHA256 with native crypto so we don't pull a JWT lib
// into the bundle. Header is fixed, payload carries customerId/email/exp,
// signature is HMAC over `header.payload`.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_DURATION_DAYS = 90;
export const SESSION_COOKIE_NAME = 'mc_session';
const SESSION_NAMESPACE = 'sess';
const SECONDS_PER_DAY = 86_400;

export interface SessionPayload {
  customerId: string;
  email: string;
}

interface SignedSessionPayload extends SessionPayload {
  ns: typeof SESSION_NAMESPACE;
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

export function isAuthConfigured(): boolean {
  const secret = import.meta.env.AUTH_SECRET;
  return typeof secret === 'string' && secret.length >= 16;
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

export function signSession(payload: SessionPayload, durationDays: number = SESSION_DURATION_DAYS): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SignedSessionPayload = {
    ns: SESSION_NAMESPACE,
    customerId: payload.customerId,
    email: payload.email,
    iat: now,
    exp: now + durationDays * SECONDS_PER_DAY,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = hmacSign(signingInput);
  return `${signingInput}.${sig}`;
}

export function verifySession(token: string | null | undefined): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (headerB64 !== HEADER_B64) return null;

  const expected = hmacSign(`${headerB64}.${payloadB64}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(sigB64);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<SignedSessionPayload>;
  if (p.ns !== SESSION_NAMESPACE) return null;
  if (typeof p.exp !== 'number' || typeof p.iat !== 'number') return null;
  if (typeof p.customerId !== 'string' || typeof p.email !== 'string') return null;
  if (p.exp <= Math.floor(Date.now() / 1000)) return null;

  return { customerId: p.customerId, email: p.email };
}

export interface CookieAttrs {
  name: string;
  value: string;
  maxAgeSeconds: number;
}

export function buildSessionCookie(token: string): string {
  const maxAge = SESSION_DURATION_DAYS * SECONDS_PER_DAY;
  return formatSetCookie({
    name: SESSION_COOKIE_NAME,
    value: token,
    maxAgeSeconds: maxAge,
  });
}

export function buildClearSessionCookie(): string {
  return formatSetCookie({ name: SESSION_COOKIE_NAME, value: '', maxAgeSeconds: 0 });
}

function formatSetCookie({ name, value, maxAgeSeconds }: CookieAttrs): string {
  const attrs = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return attrs.join('; ');
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}
