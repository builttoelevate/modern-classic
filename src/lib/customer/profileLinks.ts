// Phase 8 — parent → linked-customer KV mapping for "book for someone else."
//
// Each linked person is a real Square Customer record (own name, parent's
// phone for SMS reminders, no email). We store the parent → list-of-kids
// mapping here so the booking wizard knows who's available, and so
// /my-bookings can show the parent the kid's appointments alongside their
// own. We don't store the kid's actual contact info — that's all in
// Square; this layer is just the relationship graph.

import { Redis } from '@upstash/redis';

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
    throw new Error(
      'Upstash Redis is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.',
    );
  }
  _redis = new Redis({ url: String(url), token: String(token) });
  return _redis;
}

const KEY_PREFIX = 'mc:profile:';
function kKids(parentCustomerId: string): string {
  return `${KEY_PREFIX}kids:${parentCustomerId}`;
}
function kParent(linkedCustomerId: string): string {
  return `${KEY_PREFIX}parent:${linkedCustomerId}`;
}

export interface LinkedPerson {
  /** Square customer_id for this person. */
  customerId: string;
  /** Display name shown in the "Booking for" selector. */
  displayName: string;
  /** Optional relationship label ("Son", "Daughter", "Partner", etc.). */
  relationship?: string;
  /** ISO when the link was created. */
  linkedAt: string;
}

/**
 * Add a linked person under a parent. The Square customer is created
 * outside this helper (see /api/customer/kids); we just persist the
 * relationship.
 */
export async function linkPerson(
  parentCustomerId: string,
  person: LinkedPerson,
): Promise<void> {
  const redis = getRedis();
  // Read current list (or empty), append, write back. Last-write-wins is
  // fine here — the only writers are the same parent through the profile
  // UI, no concurrent edits expected.
  const existing = (await redis.get<LinkedPerson[]>(kKids(parentCustomerId))) ?? [];
  // Dedupe on customerId in case of double-submit.
  const filtered = existing.filter((p) => p.customerId !== person.customerId);
  filtered.push(person);
  await Promise.all([
    redis.set(kKids(parentCustomerId), filtered),
    // Reverse index so we can quickly tell "is this Square customer
    // someone's linked dependent?" — useful later if we filter them out
    // of phone-based sign-in lookups.
    redis.set(kParent(person.customerId), parentCustomerId),
  ]);
}

export async function unlinkPerson(
  parentCustomerId: string,
  linkedCustomerId: string,
): Promise<void> {
  const redis = getRedis();
  const existing = (await redis.get<LinkedPerson[]>(kKids(parentCustomerId))) ?? [];
  const filtered = existing.filter((p) => p.customerId !== linkedCustomerId);
  await Promise.all([
    redis.set(kKids(parentCustomerId), filtered),
    redis.del(kParent(linkedCustomerId)),
  ]);
}

export async function listLinkedPeople(
  parentCustomerId: string,
): Promise<LinkedPerson[]> {
  const redis = getRedis();
  const list = await redis.get<LinkedPerson[]>(kKids(parentCustomerId));
  return list ?? [];
}

export async function getLinkedParent(
  linkedCustomerId: string,
): Promise<string | null> {
  const redis = getRedis();
  const id = await redis.get<string>(kParent(linkedCustomerId));
  return typeof id === 'string' && id.length > 0 ? id : null;
}
