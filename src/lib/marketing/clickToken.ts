// Phase 7 — HMAC-signed click-tracking tokens.
//
// We share UNSUBSCRIBE_SECRET with unsubscribeToken.ts but use a different
// purpose tag (`c:`) so cross-token reuse is impossible. Payload is JSON
// of { id, dest } (request id + destination URL).

import { createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'c';

export interface ClickTokenPayload {
  reviewRequestId: string;
  destination: string;
}

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

export function signClickToken(payload: ClickTokenPayload): string {
  if (!payload?.reviewRequestId) throw new Error('signClickToken: reviewRequestId required.');
  if (!payload?.destination) throw new Error('signClickToken: destination required.');
  const secret = getSecret();
  const json = JSON.stringify({ p: PURPOSE, i: payload.reviewRequestId, d: payload.destination });
  const payloadEncoded = base64url(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadEncoded).digest();
  return `${payloadEncoded}.${base64url(sig)}`;
}

export function verifyClickToken(token: string): ClickTokenPayload | null {
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

  let parsed: { p?: string; i?: string; d?: string };
  try {
    parsed = JSON.parse(fromBase64url(payloadEncoded).toString('utf8')) as {
      p?: string;
      i?: string;
      d?: string;
    };
  } catch {
    return null;
  }
  if (parsed.p !== PURPOSE) return null;
  if (typeof parsed.i !== 'string' || !parsed.i) return null;
  if (typeof parsed.d !== 'string' || !parsed.d) return null;
  return { reviewRequestId: parsed.i, destination: parsed.d };
}
