// Authoritative record of who's in a group booking. Written by
// /api/square/group-bookings the moment all member bookings exist;
// read by groupSelfHeal when /my-bookings sees a group whose
// siblings are missing from the parent + linked-people merge.
//
// Why this exists alongside profileLinks: linkPerson encodes a
// long-lived "this customer is my dependent" relationship that
// follows the parent across future bookings. The group manifest
// encodes a one-shot "these N bookings belong to the same family
// trip on this date" fact that doesn't depend on, and isn't
// invalidated by, link-relationship changes. Either signal alone is
// fragile — link writes can fail silently (logged but swallowed in
// the booking endpoint), and a parent might unlink someone after a
// shared booking is on the calendar. The manifest is the
// always-correct breadcrumb back to every member of a specific
// group, regardless of what happens to the relationship graph.

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

const KEY_PREFIX = 'mc:group:';
function kGroup(groupId: string): string {
  return `${KEY_PREFIX}${groupId}`;
}

// 13 months. Covers the longest realistic lookback / lookahead a
// customer might use the portal for, plus a buffer so a manifest
// hasn't expired right when a customer goes to find an old booking.
const TTL_SECONDS = 60 * 60 * 24 * 30 * 13;

export interface GroupManifestMember {
  bookingId: string;
  customerId: string;
  /** Display name as shown in /my-bookings ("Bill", "Briar Bone"). */
  displayName: string;
  /** 1-based position within the group. */
  position: number;
}

export interface GroupManifest {
  groupId: string;
  /** ISO when the manifest was first written. */
  createdAt: string;
  members: GroupManifestMember[];
}

export async function recordGroupMembers(
  groupId: string,
  members: GroupManifestMember[],
): Promise<void> {
  const manifest: GroupManifest = {
    groupId,
    createdAt: new Date().toISOString(),
    members,
  };
  const redis = getRedis();
  // Two attempts with a brief backoff. Upstash occasionally returns
  // transient errors that succeed immediately on retry; if both fail
  // the caller logs and swallows so the booking response isn't
  // blocked. The phone-based fallback in groupSelfHeal.ts is the
  // belt-and-suspenders safety net for that case.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await redis.set(kGroup(groupId), manifest, { ex: TTL_SECONDS });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

export async function getGroupManifest(
  groupId: string,
): Promise<GroupManifest | null> {
  const redis = getRedis();
  const m = await redis.get<GroupManifest>(kGroup(groupId));
  return m ?? null;
}
