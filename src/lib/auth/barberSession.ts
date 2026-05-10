// Session cookies for the barber-side dashboard. Parallel to the
// customer session in session.ts: same HMAC-SHA256 signing pattern,
// same AUTH_SECRET, but with a distinct namespace marker ("barb") and
// a separate cookie name ("mc_barber_session") so the two systems
// can't be confused for each other on the wire.
//
// Payload carries { barberId, username }. The barberId is the Square
// team_member_id — that's what the dashboard filters bookings and
// waitlist entries against.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const BARBER_SESSION_DURATION_DAYS = 30;
export const BARBER_SESSION_COOKIE_NAME = 'mc_barber_session';
const BARBER_NAMESPACE = 'barb';
const SECONDS_PER_DAY = 86_400;

export interface BarberSessionPayload {
  barberId: string;
  username: string;
}

interface SignedBarberSessionPayload extends BarberSessionPayload {
  ns: typeof BARBER_NAMESPACE;
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

export function signBarberSession(
  payload: BarberSessionPayload,
  durationDays: number = BARBER_SESSION_DURATION_DAYS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SignedBarberSessionPayload = {
    ns: BARBER_NAMESPACE,
    barberId: payload.barberId,
    username: payload.username,
    iat: now,
    exp: now + durationDays * SECONDS_PER_DAY,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  return `${signingInput}.${hmacSign(signingInput)}`;
}

export function verifyBarberSession(token: string | null | undefined): BarberSessionPayload | null {
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
  const p = parsed as Partial<SignedBarberSessionPayload>;
  if (p.ns !== BARBER_NAMESPACE) return null;
  if (typeof p.exp !== 'number' || typeof p.iat !== 'number') return null;
  if (typeof p.barberId !== 'string' || typeof p.username !== 'string') return null;
  if (p.exp <= Math.floor(Date.now() / 1000)) return null;

  return { barberId: p.barberId, username: p.username };
}

export function buildBarberSessionCookie(token: string): string {
  const maxAge = BARBER_SESSION_DURATION_DAYS * SECONDS_PER_DAY;
  return formatSetCookie(BARBER_SESSION_COOKIE_NAME, token, maxAge);
}

export function buildClearBarberSessionCookie(): string {
  return formatSetCookie(BARBER_SESSION_COOKIE_NAME, '', 0);
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

export function readBarberSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === BARBER_SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}
