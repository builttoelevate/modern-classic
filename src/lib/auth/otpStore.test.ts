// Unit tests for the OTP store. Mocks @upstash/redis with an
// in-memory fake so we can exercise the state machine without a
// real Redis. Covers the contracts the verify-code endpoint depends
// on, especially the brute-force protection.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tiny in-memory Redis fake. Per-test reset.
const state: { strings: Map<string, string> } = { strings: new Map() };
function resetMockState(): void {
  state.strings.clear();
}

vi.mock('@upstash/redis', () => {
  class Redis {
    async set(key: string, value: string): Promise<'OK'> {
      state.strings.set(key, value);
      return 'OK';
    }
    async get<T>(key: string): Promise<T | null> {
      const raw = state.strings.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    }
    async del(key: string): Promise<number> {
      const had = state.strings.delete(key);
      return had ? 1 : 0;
    }
  }
  return { Redis };
});

vi.stubEnv('UPSTASH_REDIS_REST_URL', 'http://mock');
vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'mock-token');
vi.stubEnv(
  'AUTH_SECRET',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
);

import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  clearCode,
  requestCode,
  verifyCode,
} from './otpStore';

beforeEach(resetMockState);
afterEach(resetMockState);

describe('requestCode', () => {
  it('returns a 6-digit numeric code', async () => {
    const { code } = await requestCode('a@example.com');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('overwrites any previous code for the same email', async () => {
    const first = await requestCode('a@example.com');
    const second = await requestCode('a@example.com');
    // First code should no longer verify; only the second should.
    expect((await verifyCode('a@example.com', first.code)).ok).toBe(false);
    expect((await verifyCode('a@example.com', second.code)).ok).toBe(true);
  });

  it('normalizes email case for storage', async () => {
    const { code } = await requestCode('Mixed@Example.COM');
    // The stored key is lowercase; verify with lowercase succeeds.
    expect((await verifyCode('mixed@example.com', code)).ok).toBe(true);
  });

  it('rejects empty email', async () => {
    await expect(requestCode('')).rejects.toThrow(/email is required/);
  });
});

describe('verifyCode — happy path', () => {
  it('returns ok and clears the entry on a correct code', async () => {
    const { code } = await requestCode('a@example.com');
    expect((await verifyCode('a@example.com', code)).ok).toBe(true);
    // Single-use — re-verify with the same code now expires.
    const second = await verifyCode('a@example.com', code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('expired');
  });
});

describe('verifyCode — expired / missing', () => {
  it('returns expired when no code was ever requested', async () => {
    const result = await verifyCode('nobody@example.com', '000000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('returns expired after the TTL has passed', async () => {
    const { code } = await requestCode('a@example.com');
    // Fast-forward Date.now beyond expiresAtMs by stubbing.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + (OTP_TTL_SECONDS + 1) * 1000;
      const result = await verifyCode('a@example.com', code);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('expired');
    } finally {
      Date.now = realNow;
    }
  });
});

describe('verifyCode — mismatch + lockout', () => {
  it('returns mismatch with attemptsLeft decremented', async () => {
    await requestCode('a@example.com');
    const result = await verifyCode('a@example.com', '000000');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'mismatch') {
      expect(result.attemptsLeft).toBe(OTP_MAX_ATTEMPTS - 1);
    } else {
      throw new Error('expected mismatch');
    }
  });

  it('locks out after OTP_MAX_ATTEMPTS bad attempts', async () => {
    await requestCode('a@example.com');
    let lastResult;
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      lastResult = await verifyCode('a@example.com', '000000');
    }
    expect(lastResult?.ok).toBe(false);
    if (lastResult && !lastResult.ok) {
      expect(lastResult.reason).toBe('locked');
    }
    // One more attempt — still locked.
    const after = await verifyCode('a@example.com', '000000');
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('locked');
  });

  it('locked state survives even when the correct code is submitted', async () => {
    const { code } = await requestCode('a@example.com');
    // Burn all attempts on wrong codes.
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await verifyCode('a@example.com', '000000');
    }
    // Now submit the correct code — should still be rejected.
    const result = await verifyCode('a@example.com', code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('locked');
  });

  it('rejects empty code as a mismatch (not a crash)', async () => {
    await requestCode('a@example.com');
    const result = await verifyCode('a@example.com', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });
});

describe('clearCode', () => {
  it('removes a pending code so the next verify is expired', async () => {
    const { code } = await requestCode('a@example.com');
    await clearCode('a@example.com');
    const result = await verifyCode('a@example.com', code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });
});

describe('isolation between accounts', () => {
  it('a code for one email does not verify for another', async () => {
    const a = await requestCode('a@example.com');
    await requestCode('b@example.com');
    const wrongAccount = await verifyCode('b@example.com', a.code);
    expect(wrongAccount.ok).toBe(false);
    // Should be a mismatch (not expired) — b has its own entry.
    if (!wrongAccount.ok) expect(wrongAccount.reason).toBe('mismatch');
    // Original code still works on the right account.
    expect((await verifyCode('a@example.com', a.code)).ok).toBe(true);
  });
});
