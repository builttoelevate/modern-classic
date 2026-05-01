// Phase 7 — HMAC-signed unsubscribe tokens.
//
// Tokens never expire (an unsubscribe link should still work years later).
// Format: base64url(payload).base64url(signature) where payload is
// "u:<customerId>". The "u:" prefix is a domain tag so the same secret
// can also sign click-tracking tokens (prefix "c:") without cross-use.
//
// We use Node's native crypto, no external library.

import { createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'u';

function getSecret(): string {
  if (typeof window !== 'undefined') {
    throw new Error('UNSUBSCRIBE_SECRET is server-only.');
  }
  const secret = import.meta.env.UNSUBSCRIBE_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error('UNSUBSCRIBE_SECRET is not set (must be ≥ 16 chars).');
  }
  return secret;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signUnsubscribeToken(customerId: string): string {
  if (!customerId || typeof customerId !== 'string') {
    throw new Error('signUnsubscribeToken: customerId is required.');
  }
  const secret = getSecret();
  const payload = `${PURPOSE}:${customerId}`;
  const payloadEncoded = base64url(Buffer.from(payload, 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadEncoded).digest();
  return `${payloadEncoded}.${base64url(sig)}`;
}

export function verifyUnsubscribeToken(token: string): { customerId: string } | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadEncoded = token.slice(0, dot);
  const sigEncoded = token.slice(dot + 1);

  const secret = getSecret();
  const expected = createHmac('sha256', secret).update(payloadEncoded).digest();
  let provided: Buffer;
  try {
    provided = fromBase64url(sigEncoded);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: string;
  try {
    payload = fromBase64url(payloadEncoded).toString('utf8');
  } catch {
    return null;
  }
  const colon = payload.indexOf(':');
  if (colon < 0) return null;
  if (payload.slice(0, colon) !== PURPOSE) return null;
  const customerId = payload.slice(colon + 1);
  if (!customerId) return null;
  return { customerId };
}
