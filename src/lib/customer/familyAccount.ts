// Family-account graph in Redis. Two-adults-share-a-Modern-Classic-
// account model: each adult sees the other adult's bookings + any
// linked kids' bookings on /my-bookings, in the same merged list
// the existing parent→kid model already powers.
//
// Coexists with the legacy mc:profile:kids index — /my-bookings
// checks family first, falls back to listLinkedPeople when no
// family record exists, so existing parent→kid links keep working
// without forced migration.

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

const FAMILY_PREFIX = 'mc:fam:';
const kFamily = (id: string) => `${FAMILY_PREFIX}byId:${id}`;
const kByCustomer = (cid: string) => `${FAMILY_PREFIX}byCustomer:${cid}`;
const kInvite = (token: string) => `${FAMILY_PREFIX}invite:${token}`;

// 7 days; long enough that a casual inviter doesn't have to chase
// the invitee with reminders, short enough that stale invites
// don't pile up forever in Redis.
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Hard cap on members per family. Four adults + two kids covers
// realistic blended-family cases; anything bigger reads as a
// different concept ("household account") that we'd build
// separately if it ever comes up.
export const MAX_FAMILY_MEMBERS = 6;
export const MAX_FAMILY_ADULTS = 4;

export type FamilyRole = 'adult' | 'kid';

export interface FamilyMember {
  customerId: string;
  role: FamilyRole;
  displayName: string;
  /** "Spouse", "Partner", "Son", "Daughter", etc. Optional. */
  relationship?: string;
  /** ISO timestamp when this member was added. */
  joinedAt: string;
}

export interface FamilyRecord {
  familyId: string;
  createdAt: string;
  members: FamilyMember[];
}

export interface InviteRecord {
  familyId: string;
  invitedEmail: string;
  invitedByCustomerId: string;
  invitedAt: string;
  expiresAt: string;
}

function newFamilyId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `mc-fam-${hex}`;
}

function newInviteToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Look up the family a customer belongs to. Returns null when the
 * customer isn't in any family — the caller can fall back to the
 * legacy parent→kid model.
 */
export async function getFamilyForCustomer(
  customerId: string,
): Promise<FamilyRecord | null> {
  const redis = getRedis();
  const familyId = await redis.get<string>(kByCustomer(customerId));
  if (!familyId) return null;
  const record = await redis.get<FamilyRecord>(kFamily(familyId));
  return record ?? null;
}

export async function getFamilyById(familyId: string): Promise<FamilyRecord | null> {
  const redis = getRedis();
  const record = await redis.get<FamilyRecord>(kFamily(familyId));
  return record ?? null;
}

/**
 * Create a fresh family with the caller as the sole adult. No-op
 * (returns the existing family) when the caller already belongs to
 * one — keeps the create endpoint idempotent for double-click cases
 * and surfaces the existing family to the UI so it can render the
 * member list instead of an empty state.
 */
export async function createFamily(input: {
  founderCustomerId: string;
  founderDisplayName: string;
}): Promise<FamilyRecord> {
  const existing = await getFamilyForCustomer(input.founderCustomerId);
  if (existing) return existing;

  const family: FamilyRecord = {
    familyId: newFamilyId(),
    createdAt: new Date().toISOString(),
    members: [
      {
        customerId: input.founderCustomerId,
        role: 'adult',
        displayName: input.founderDisplayName || 'Customer',
        joinedAt: new Date().toISOString(),
      },
    ],
  };

  const redis = getRedis();
  await Promise.all([
    redis.set(kFamily(family.familyId), family),
    redis.set(kByCustomer(input.founderCustomerId), family.familyId),
  ]);
  return family;
}

/** Member-cap check used by add-member endpoints. Returns null when ok. */
function memberCapError(family: FamilyRecord, addingRole: FamilyRole): string | null {
  if (family.members.length >= MAX_FAMILY_MEMBERS) {
    return `Family is at the ${MAX_FAMILY_MEMBERS}-member cap.`;
  }
  if (addingRole === 'adult') {
    const adultCount = family.members.filter((m) => m.role === 'adult').length;
    if (adultCount >= MAX_FAMILY_ADULTS) {
      return `Family is at the ${MAX_FAMILY_ADULTS}-adult cap.`;
    }
  }
  return null;
}

/**
 * Add a member to an existing family. Dedupes on customerId — if the
 * customer is already in the family, returns the unchanged record.
 * Refuses (throws) when the family is at its cap or the customer
 * already belongs to a different family.
 */
export async function addFamilyMember(
  familyId: string,
  member: Omit<FamilyMember, 'joinedAt'>,
): Promise<FamilyRecord> {
  const redis = getRedis();
  const family = await getFamilyById(familyId);
  if (!family) throw new Error(`Family ${familyId} not found.`);

  // Already a member? No-op return.
  if (family.members.some((m) => m.customerId === member.customerId)) {
    return family;
  }

  // Belongs to a different family already?
  const otherFamilyId = await redis.get<string>(kByCustomer(member.customerId));
  if (otherFamilyId && otherFamilyId !== familyId) {
    throw new Error('Customer already belongs to a different family.');
  }

  const capErr = memberCapError(family, member.role);
  if (capErr) throw new Error(capErr);

  const updated: FamilyRecord = {
    ...family,
    members: [...family.members, { ...member, joinedAt: new Date().toISOString() }],
  };
  await Promise.all([
    redis.set(kFamily(familyId), updated),
    redis.set(kByCustomer(member.customerId), familyId),
  ]);
  return updated;
}

/**
 * Remove a member by customerId. Three terminal cases:
 *   - Removing a kid: just drops them.
 *   - Removing an adult, others remain: drops them.
 *   - Removing the last adult: dissolves the family entirely.
 *     Kids fall back to a legacy mc:profile:kids pointer to the
 *     leaving adult so they don't orphan — that path is the
 *     caller's responsibility (PR 2's leave endpoint handles it).
 *
 * Returns the updated record, or null when the family was dissolved.
 */
export async function removeFamilyMember(
  familyId: string,
  customerId: string,
): Promise<FamilyRecord | null> {
  const redis = getRedis();
  const family = await getFamilyById(familyId);
  if (!family) return null;

  const remaining = family.members.filter((m) => m.customerId !== customerId);
  if (remaining.length === family.members.length) {
    // Wasn't in this family — no-op.
    return family;
  }

  const adultsLeft = remaining.filter((m) => m.role === 'adult').length;
  if (adultsLeft === 0) {
    // Dissolve. Drop the family + every byCustomer pointer.
    await Promise.all([
      redis.del(kFamily(familyId)),
      ...family.members.map((m) => redis.del(kByCustomer(m.customerId))),
    ]);
    return null;
  }

  const updated: FamilyRecord = { ...family, members: remaining };
  await Promise.all([
    redis.set(kFamily(familyId), updated),
    redis.del(kByCustomer(customerId)),
  ]);
  return updated;
}

/**
 * Hard-delete a family record + every member→family pointer. Used by
 * the admin "dissolve family" action when a family got created wrong
 * (e.g., wrong customer joined someone else's family, or a test
 * family needs to be wiped). Customers fall back to the legacy
 * linkedPeople / solo /my-bookings path immediately after.
 *
 * Returns true if a family was found and dissolved, false otherwise.
 */
export async function dissolveFamily(familyId: string): Promise<boolean> {
  const redis = getRedis();
  const family = await getFamilyById(familyId);
  if (!family) return false;
  await Promise.all([
    redis.del(kFamily(familyId)),
    ...family.members.map((m) => redis.del(kByCustomer(m.customerId))),
  ]);
  return true;
}

export interface CreateInviteInput {
  familyId: string;
  invitedEmail: string;
  invitedByCustomerId: string;
}

export async function createInvite(
  input: CreateInviteInput,
): Promise<{ token: string; record: InviteRecord }> {
  const token = newInviteToken();
  const now = Date.now();
  const record: InviteRecord = {
    familyId: input.familyId,
    invitedEmail: input.invitedEmail.trim().toLowerCase(),
    invitedByCustomerId: input.invitedByCustomerId,
    invitedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_SECONDS * 1000).toISOString(),
  };
  const redis = getRedis();
  await redis.set(kInvite(token), record, { ex: INVITE_TTL_SECONDS });
  return { token, record };
}

export async function getInvite(token: string): Promise<InviteRecord | null> {
  const redis = getRedis();
  const record = await redis.get<InviteRecord>(kInvite(token));
  return record ?? null;
}

/**
 * One-shot read+delete for an invite token. Used at accept time so
 * the same token can't be replayed. Returns the record if it was
 * present, null otherwise. The accept handler should pre-validate
 * the email match before calling this — once consumed, the token
 * is gone whether the accept ultimately succeeds or not.
 */
export async function consumeInvite(token: string): Promise<InviteRecord | null> {
  const redis = getRedis();
  const record = await redis.get<InviteRecord>(kInvite(token));
  if (record) await redis.del(kInvite(token));
  return record ?? null;
}
