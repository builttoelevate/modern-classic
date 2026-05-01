// Phase 5 Part A — single-use magic-link tokens.
//
// Same JWT-shape format as session tokens but with a "magic:" namespace so
// a session cookie can never be replayed as a magic link, and vice versa.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAGIC_NAMESPACE = 'magic';
const MAGIC_TTL_SECONDS = 15 * 60;

export interface MagicTokenInput {
  email: string;
  /** A 16-byte random nonce. signMagicToken generates one when not supplied. */
  nonce?: string;
}

interface SignedMagicPayload {
  ns: typeof MAGIC_NAMESPACE;
  email: string;
  nonce: string;
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

const HEADER_B64 = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'MAG' }));

function hmacSign(input: string): string {
  const h = createHmac('sha256', getSecret());
  h.update(input);
  return base64UrlEncode(h.digest());
}

export function signMagicToken(input: MagicTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const body: SignedMagicPayload = {
    ns: MAGIC_NAMESPACE,
    email: input.email.trim().toLowerCase(),
    nonce,
    iat: now,
    exp: now + MAGIC_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = hmacSign(signingInput);
  return `${signingInput}.${sig}`;
}

interface VerifiedMagic {
  email: string;
  nonce: string;
}

function verifyShape(token: string): VerifiedMagic | null {
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
  const p = parsed as Partial<SignedMagicPayload>;
  if (p.ns !== MAGIC_NAMESPACE) return null;
  if (typeof p.email !== 'string' || typeof p.nonce !== 'string') return null;
  if (typeof p.iat !== 'number' || typeof p.exp !== 'number') return null;
  if (p.exp <= Math.floor(Date.now() / 1000)) return null;
  return { email: p.email, nonce: p.nonce };
}

// Single-use protection. Vercel functions are short-lived so this only
// catches the realistic attack window (a stolen link replayed within the
// same warm instance), but it's still worth doing.
const usedNonces = new Map<string, number>();

function pruneUsedNonces(now: number): void {
  if (usedNonces.size < 256) return;
  for (const [nonce, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(nonce);
  }
}

export function verifyMagicToken(token: string | null | undefined): { email: string } | null {
  if (!token || typeof token !== 'string') return null;
  const verified = verifyShape(token);
  if (!verified) return null;

  const nowMs = Date.now();
  const expiresAtMs = nowMs + MAGIC_TTL_SECONDS * 1000;
  const existing = usedNonces.get(verified.nonce);
  if (existing && existing > nowMs) {
    return null;
  }
  usedNonces.set(verified.nonce, expiresAtMs);
  pruneUsedNonces(nowMs);
  return { email: verified.email };
}
