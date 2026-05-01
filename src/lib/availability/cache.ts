// Phase 6 Part A — in-memory TTL cache.
//
// Vercel function instances are warm for several minutes between
// invocations. A module-level Map gives us per-instance cache hits with
// zero infrastructure. Across instances we just recompute — fine.

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

function pruneExpired(now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = store.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.value as T;
  }
  // Opportunistic cleanup whenever we miss — keeps the Map bounded.
  pruneExpired(now);
  const value = await compute();
  store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
  return value;
}

export function invalidate(key: string): void {
  store.delete(key);
}

/** Test-only — clears the entire cache. */
export function _resetForTests(): void {
  store.clear();
}
