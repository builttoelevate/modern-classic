// Unit tests for the block-list helper. Mocks @upstash/redis with a
// tiny in-memory fake so the helper logic can be exercised without a
// real Redis. Covers the contracts the booking endpoints depend on:
//
//   - Phone normalization happens before lookup
//   - assertPhoneNotBlocked throws CustomerBlockedError on hit, returns
//     void on miss
//   - The attempts stream is XADD'd on every hit
//   - Stream-log failure does NOT block enforcement (helper still throws)
//   - addBlockedPhone is idempotent — second call returns
//     status: 'already_blocked' with the ORIGINAL metadata intact

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory Redis fake. Each instance is its own state; resetMockState()
// wipes everything between tests. xadd's `xaddShouldThrow` toggle lets a
// test simulate the stream being unreachable.
interface FakeRedisState {
  strings: Map<string, string>;
  sets: Map<string, Set<string>>;
  streamCalls: Array<{ key: string; id: string; entries: Record<string, unknown> }>;
  xaddShouldThrow: boolean;
}
const state: FakeRedisState = {
  strings: new Map(),
  sets: new Map(),
  streamCalls: [],
  xaddShouldThrow: false,
};

function resetMockState(): void {
  state.strings.clear();
  state.sets.clear();
  state.streamCalls = [];
  state.xaddShouldThrow = false;
}

vi.mock('@upstash/redis', () => {
  class Redis {
    async sadd(key: string, member: string): Promise<number> {
      const set = state.sets.get(key) ?? new Set<string>();
      const had = set.has(member);
      set.add(member);
      state.sets.set(key, set);
      return had ? 0 : 1;
    }
    async srem(key: string, member: string): Promise<number> {
      const set = state.sets.get(key);
      if (!set) return 0;
      const had = set.delete(member);
      return had ? 1 : 0;
    }
    async sismember(key: string, member: string): Promise<number> {
      return state.sets.get(key)?.has(member) ? 1 : 0;
    }
    async smembers(key: string): Promise<string[]> {
      return Array.from(state.sets.get(key) ?? []);
    }
    async set(key: string, value: string): Promise<'OK'> {
      state.strings.set(key, value);
      return 'OK';
    }
    async get<T>(key: string): Promise<T | null> {
      const raw = state.strings.get(key);
      if (raw === undefined) return null;
      // Upstash auto-parses JSON; mirror that for parity with prod.
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
    async xadd(
      key: string,
      id: string,
      entries: Record<string, unknown>,
    ): Promise<string> {
      if (state.xaddShouldThrow) throw new Error('mock-redis: XADD failed');
      state.streamCalls.push({ key, id, entries });
      return `${Date.now()}-0`;
    }
  }
  return { Redis };
});

// Ensure import.meta.env URLs are set so getRedis() doesn't throw
// before our mock takes over.
vi.stubEnv('UPSTASH_REDIS_REST_URL', 'http://mock');
vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'mock-token');

import {
  CustomerBlockedError,
  addBlockedPhone,
  assertPhoneNotBlocked,
  blockedBookingPublicResponse,
  isPhoneBlocked,
  listBlockedEntries,
  removeBlockedById,
  type BlockAttemptContext,
} from './blockedCustomers';

beforeEach(resetMockState);
afterEach(resetMockState);

const ATTEMPT_CTX: BlockAttemptContext = {
  bookingContext: 'single',
  customerName: 'Test Person',
  customerEmail: 'test@example.com',
  serviceId: 'svc_x',
  barberId: 'tm_y',
  selectedStartAt: '2026-06-01T15:00:00Z',
};

describe('addBlockedPhone', () => {
  it('returns status: created on first add', async () => {
    const result = await addBlockedPhone('740-555-1234', { reason: 'no-show' });
    expect(result.status).toBe('created');
    expect(result.block.phone).toBe('+17405551234');
    expect(result.block.phoneOriginal).toBe('740-555-1234');
    expect(result.block.reason).toBe('no-show');
    expect(result.block.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is idempotent and preserves original metadata on dupe', async () => {
    const first = await addBlockedPhone('740-555-1234', { reason: 'first reason' });
    // Sleep 5ms so a re-write would produce a different blockedAt
    await new Promise((r) => setTimeout(r, 5));
    const second = await addBlockedPhone('+17405551234', { reason: 'second reason — should be ignored' });
    expect(second.status).toBe('already_blocked');
    // Original blockedAt + reason preserved; the loser's payload is discarded.
    expect(second.block.id).toBe(first.block.id);
    expect(second.block.reason).toBe('first reason');
    expect(second.block.blockedAt).toBe(first.block.blockedAt);
  });

  it('rejects unparseable phone input', async () => {
    await expect(addBlockedPhone('abc')).rejects.toThrow(/not a valid E\.164/);
    await expect(addBlockedPhone('')).rejects.toThrow();
  });
});

describe('isPhoneBlocked', () => {
  it('returns true for a blocked phone (any format)', async () => {
    await addBlockedPhone('(740) 555-1234');
    expect(await isPhoneBlocked('740-555-1234')).toBe(true);
    expect(await isPhoneBlocked('+17405551234')).toBe(true);
    expect(await isPhoneBlocked('7405551234')).toBe(true);
  });

  it('returns false for an unknown phone', async () => {
    await addBlockedPhone('740-555-1234');
    expect(await isPhoneBlocked('555-000-9999')).toBe(false);
  });
});

describe('assertPhoneNotBlocked', () => {
  it('returns void for a non-blocked phone', async () => {
    await expect(assertPhoneNotBlocked('555-000-9999', ATTEMPT_CTX)).resolves.toBeUndefined();
    expect(state.streamCalls.length).toBe(0);
  });

  it('throws CustomerBlockedError for a blocked phone', async () => {
    await addBlockedPhone('740-555-1234', { reason: 'internal' });
    await expect(assertPhoneNotBlocked('(740) 555-1234', ATTEMPT_CTX)).rejects.toBeInstanceOf(
      CustomerBlockedError,
    );
  });

  it('normalizes input phone before lookup', async () => {
    await addBlockedPhone('+17405551234');
    // Different format input — should still match.
    await expect(assertPhoneNotBlocked('740.555.1234', ATTEMPT_CTX)).rejects.toBeInstanceOf(
      CustomerBlockedError,
    );
  });

  it('XADDs to the attempts stream on hit with the booking context', async () => {
    await addBlockedPhone('740-555-1234');
    await expect(assertPhoneNotBlocked('740-555-1234', ATTEMPT_CTX)).rejects.toBeInstanceOf(
      CustomerBlockedError,
    );
    expect(state.streamCalls.length).toBe(1);
    const call = state.streamCalls[0];
    expect(call.key).toContain('block:attempts');
    expect(call.id).toBe('*');
    expect(call.entries.bookingContext).toBe('single');
    expect(call.entries.phone).toBe('+17405551234');
    expect(call.entries.customerName).toBe('Test Person');
    expect(call.entries.serviceId).toBe('svc_x');
  });

  it('still throws when the attempts-stream write fails (enforcement > logging)', async () => {
    await addBlockedPhone('740-555-1234');
    state.xaddShouldThrow = true;
    // Silence the console.error noise so test output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(assertPhoneNotBlocked('740-555-1234', ATTEMPT_CTX)).rejects.toBeInstanceOf(
        CustomerBlockedError,
      );
      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('stream-log-failed');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('blockedBookingPublicResponse', () => {
  it('returns 403 with the BOOKING_UNAVAILABLE_ONLINE code and generic copy', async () => {
    const res = blockedBookingPublicResponse();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BOOKING_UNAVAILABLE_ONLINE');
    // No leakage: never contains 'block'/'blocked'/'banned' in the public detail.
    const detail = String(body.error.detail).toLowerCase();
    expect(detail).not.toContain('block');
    expect(detail).not.toContain('banned');
    expect(detail).not.toContain('ban ');
  });
});

describe('listBlockedEntries / removeBlockedById', () => {
  it('lists newest-first', async () => {
    const a = await addBlockedPhone('740-555-1111');
    await new Promise((r) => setTimeout(r, 5));
    const b = await addBlockedPhone('740-555-2222');
    const entries = await listBlockedEntries();
    expect(entries.length).toBe(2);
    expect(entries[0].id).toBe(b.block.id);
    expect(entries[1].id).toBe(a.block.id);
  });

  it('removes by id and unblocks future checks', async () => {
    const added = await addBlockedPhone('740-555-1111');
    expect(await isPhoneBlocked('740-555-1111')).toBe(true);
    const removed = await removeBlockedById(added.block.id);
    expect(removed?.id).toBe(added.block.id);
    expect(await isPhoneBlocked('740-555-1111')).toBe(false);
    // Idempotent — second remove returns null.
    expect(await removeBlockedById(added.block.id)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await removeBlockedById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
