// One-time code (OTP) store for customer auth.
//
// Why this exists: magic-link sign-in fails for users whose email
// client opens links in an isolated in-app browser (ProtonMail being
// the most common offender on iOS). The cookie set when the user
// taps the magic link lands in that in-app browser's cookie jar and
// never reaches Safari — every time the customer opens the site
// from their home screen they're signed out again.
//
// The fix is a 6-digit code the customer reads in their email and
// types into the sign-in form. The cookie lands in whatever browser
// the customer started in. No cross-browser handoff required.
//
// Storage: Upstash Redis. Key `mc:auth:otp:<emailLower>` holds a
// small JSON payload with a hashed code, an attempt counter, and an
// expiry. TTL set in Redis matches the in-payload expiry (15 min);
// either eviction wins. After 5 failed verify attempts the entry is
// effectively dead — the next attempt is rejected with `locked`,
// forcing the customer to request a fresh code.
//
// Security:
//   - The plaintext code is returned ONLY by requestCode(), to be
//     emailed. It is NEVER stored.
//   - What's stored is HMAC-SHA256(code, AUTH_SECRET) so a Redis
//     compromise alone doesn't yield valid codes.
//   - verifyCode() compares with timingSafeEqual.
//   - Single-use — successful verification deletes the entry.
//   - 5-attempt lockout — attempts counter is incremented on every
//     mismatch and persisted before the response so a brute-force
//     can't outrun the cap.

import { Redis } from '@upstash/redis';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (_redis) return _redis;
  if (typeof window !== 'undefined') {
    throw new Error('Upstash Redis is server-only.');
  }
  const url =
    import.meta.env.UPSTASH_REDIS_REST_URL ??
    import.meta.env.KV_REST_API_URL ??
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.KV_REST_API_URL;
  const token =
    import.meta.env.UPSTASH_REDIS_REST_TOKEN ??
    import.meta.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Upstash Redis is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.');
  }
  _redis = new Redis({ url: String(url), token: String(token) });
  return _redis;
}

function getSecret(): string {
  const secret = import.meta.env.AUTH_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error('AUTH_SECRET is not set or too short. Generate one with `openssl rand -hex 32`.');
  }
  return secret;
}

const KEY_PREFIX = 'mc:auth:otp:';
export const OTP_TTL_SECONDS = 15 * 60;
export const OTP_MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;

function kOtp(email: string): string {
  return `${KEY_PREFIX}${email.trim().toLowerCase()}`;
}

function hashCode(code: string): string {
  return createHmac('sha256', getSecret()).update(code).digest('hex');
}

interface StoredOtp {
  /** HMAC-SHA256 of the plaintext code, hex-encoded. */
  codeHash: string;
  /** Failed-verify counter. Successful verify deletes the entry; the
   *  counter therefore only matters for mismatched submissions. */
  attempts: number;
  /** ISO timestamp the code was issued. */
  requestedAt: string;
  /** Unix ms when the code becomes invalid. Redis TTL backs this up. */
  expiresAtMs: number;
}

export interface RequestCodeResult {
  /** Plaintext 6-digit code. Caller emails this; do NOT log or store. */
  code: string;
}

/**
 * Generate a fresh 6-digit code for an email, hash it, persist with a
 * 15-minute TTL, and return the plaintext to be emailed.
 *
 * Re-requesting always OVERWRITES the previous entry. There's no
 * "you already have a code, wait it out" branch — if a user asked
 * for a fresh code, give them a fresh code. The rate-limit decision
 * lives at the route layer (matches the existing magic-link
 * endpoint pattern).
 */
export async function requestCode(email: string): Promise<RequestCodeResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('email is required');
  // 6-digit zero-padded. randomInt is the crypto-grade RNG.
  const code = String(randomInt(0, 1_000_000)).padStart(CODE_DIGITS, '0');
  const now = Date.now();
  const entry: StoredOtp = {
    codeHash: hashCode(code),
    attempts: 0,
    requestedAt: new Date(now).toISOString(),
    expiresAtMs: now + OTP_TTL_SECONDS * 1000,
  };
  await getRedis().set(kOtp(normalized), JSON.stringify(entry), { ex: OTP_TTL_SECONDS });
  return { code };
}

export type VerifyCodeOutcome =
  | { ok: true }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'locked' }
  | { ok: false; reason: 'mismatch'; attemptsLeft: number };

/**
 * Validate a customer-submitted code against the stored hash. On
 * success the entry is deleted (single-use). On mismatch the attempts
 * counter is incremented and persisted BEFORE the response so a
 * brute-force can't outrun the cap.
 */
export async function verifyCode(email: string, code: string): Promise<VerifyCodeOutcome> {
  const normalized = email.trim().toLowerCase();
  const trimmedCode = (code ?? '').trim();
  if (!normalized || !trimmedCode) {
    return { ok: false, reason: 'mismatch', attemptsLeft: OTP_MAX_ATTEMPTS };
  }
  const redis = getRedis();
  const key = kOtp(normalized);
  const raw = await redis.get<StoredOtp | string | null>(key);
  if (raw == null) return { ok: false, reason: 'expired' };
  const entry: StoredOtp | null =
    typeof raw === 'string' ? safeParse(raw) : (raw as StoredOtp);
  if (!entry || !entry.codeHash) return { ok: false, reason: 'expired' };
  if (Date.now() > entry.expiresAtMs) {
    // Stale by our reckoning; clear it so a subsequent request gets
    // a clean slate.
    await redis.del(key).catch(() => undefined);
    return { ok: false, reason: 'expired' };
  }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: 'locked' };
  }

  const expectedHex = entry.codeHash;
  const actualHex = hashCode(trimmedCode);
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(actualHex, 'hex');
  const same = a.length === b.length && timingSafeEqual(a, b);

  if (!same) {
    const updated: StoredOtp = { ...entry, attempts: entry.attempts + 1 };
    const remainingMs = entry.expiresAtMs - Date.now();
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
    await redis.set(key, JSON.stringify(updated), { ex: remainingSec });
    const attemptsLeft = Math.max(0, OTP_MAX_ATTEMPTS - updated.attempts);
    if (attemptsLeft === 0) return { ok: false, reason: 'locked' };
    return { ok: false, reason: 'mismatch', attemptsLeft };
  }

  // Match — single-use, delete it.
  await redis.del(key).catch(() => undefined);
  return { ok: true };
}

/** Wipes an outstanding code for an email. Used after a successful
 *  verify (covered above) and also exposed for admin/operator tooling
 *  to forcibly clear a stuck entry. */
export async function clearCode(email: string): Promise<void> {
  await getRedis().del(kOtp(email.trim().toLowerCase()));
}

function safeParse(s: string): StoredOtp | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && 'codeHash' in v) return v as StoredOtp;
    return null;
  } catch {
    return null;
  }
}
