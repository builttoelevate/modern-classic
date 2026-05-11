// KV CRUD for barber accounts. Each Square team_member_id maps to at
// most one barber account (username + password hash + mustChangePassword
// flag). Two keys per account so we can look up by team_member_id for
// the dashboard, and by username for the login endpoint:
//
//   mc:barber:account:{teamMemberId}   → BarberAccountRecord (JSON)
//   mc:barber:username:{username}      → { teamMemberId }
//
// Usernames are normalized to lowercase ASCII before storage; the
// reverse-lookup key uses the normalized form.

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

export interface BarberAccountRecord {
  teamMemberId: string;
  /** Normalized lowercase username. Stable identifier for the login form. */
  username: string;
  /** scrypt-formatted password hash. See passwordHash.ts. */
  passwordHash: string;
  /** True until the barber sets their own password after a provision/reset.
   *  Login still succeeds, but the dashboard routes them to /barber/change-password. */
  mustChangePassword: boolean;
  /** Inbox where waitlist notifications for this barber are sent.
   *  Optional — when unset we fall back to Square's TeamMember.email_address,
   *  and if that's also missing we skip the barber notification silently.
   *  Lowercased + trimmed on write. */
  email?: string;
  createdAt: string;
  updatedAt: string;
}

const KEY_PREFIX = 'mc:barber:';
const KEY_INDEX = `${KEY_PREFIX}index`;

function kAccount(teamMemberId: string): string {
  return `${KEY_PREFIX}account:${teamMemberId}`;
}
function kUsername(username: string): string {
  return `${KEY_PREFIX}username:${username}`;
}

/** Trims, lowercases, and strips non-`[a-z0-9_-]` chars. Throws if the
 *  result is empty or too short — usernames are typed by humans, we
 *  want a minimum of 2 chars to keep collisions easy to spot. */
export function normalizeUsername(raw: string): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  const cleaned = trimmed.replace(/[^a-z0-9_-]/g, '');
  if (cleaned.length < 2) {
    throw new Error('username must be at least 2 characters (letters, digits, _ or -)');
  }
  return cleaned;
}

export async function getAccount(teamMemberId: string): Promise<BarberAccountRecord | null> {
  const r = getRedis();
  const rec = await r.get<BarberAccountRecord>(kAccount(teamMemberId));
  return rec ?? null;
}

export async function getAccountByUsername(username: string): Promise<BarberAccountRecord | null> {
  const r = getRedis();
  let normalized: string;
  try {
    normalized = normalizeUsername(username);
  } catch {
    return null;
  }
  const idx = await r.get<{ teamMemberId: string }>(kUsername(normalized));
  if (!idx || typeof idx.teamMemberId !== 'string') return null;
  return getAccount(idx.teamMemberId);
}

export interface UpsertAccountInput {
  teamMemberId: string;
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
  /** Optional inbox for waitlist notifications. Pass undefined to leave
   *  the existing email alone (or to keep none, on initial provision). */
  email?: string;
}

/** Validates + normalizes an email address. Returns the lowercased
 *  trimmed form, or null if it doesn't pass the basic shape check. */
export function normalizeEmail(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^\S+@\S+\.\S+$/.test(trimmed)) return null;
  if (trimmed.length > 254) return null;
  return trimmed;
}

/** Creates a new account or replaces an existing one for the same
 *  team_member_id. If the username changed, the old reverse-lookup key
 *  is deleted to avoid orphan pointers. If another barber already owns
 *  the requested username, this throws — the caller (admin endpoint)
 *  should surface a friendly conflict error. */
export async function upsertAccount(input: UpsertAccountInput): Promise<BarberAccountRecord> {
  const r = getRedis();
  const normalized = normalizeUsername(input.username);

  // Reject if the requested username is taken by a different team member.
  const existingByUsername = await r.get<{ teamMemberId: string }>(kUsername(normalized));
  if (
    existingByUsername &&
    existingByUsername.teamMemberId &&
    existingByUsername.teamMemberId !== input.teamMemberId
  ) {
    throw new Error(`username "${normalized}" is already taken`);
  }

  const existing = await getAccount(input.teamMemberId);
  const now = new Date().toISOString();
  // Email handling: an explicit string in input.email overwrites
  // (after normalization); undefined means "leave the existing value
  // alone"; an empty string clears it.
  let email = existing?.email;
  if (input.email !== undefined) {
    if (input.email === '') {
      email = undefined;
    } else {
      const normalizedEmail = normalizeEmail(input.email);
      if (normalizedEmail === null) {
        throw new Error('email is not a valid address');
      }
      email = normalizedEmail;
    }
  }
  const record: BarberAccountRecord = {
    teamMemberId: input.teamMemberId,
    username: normalized,
    passwordHash: input.passwordHash,
    mustChangePassword: input.mustChangePassword,
    ...(email ? { email } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await r.set(kAccount(input.teamMemberId), record);
  await r.set(kUsername(normalized), { teamMemberId: input.teamMemberId });
  await r.sadd(KEY_INDEX, input.teamMemberId);

  // If the username was renamed, clean up the old reverse pointer.
  if (existing && existing.username && existing.username !== normalized) {
    await r.del(kUsername(existing.username));
  }
  return record;
}

/** Updates only the password hash + mustChangePassword flag, leaving
 *  username + createdAt intact. Used by the change-password endpoint. */
export async function updateAccountPassword(
  teamMemberId: string,
  passwordHash: string,
  mustChangePassword: boolean,
): Promise<BarberAccountRecord | null> {
  const r = getRedis();
  const existing = await getAccount(teamMemberId);
  if (!existing) return null;
  const updated: BarberAccountRecord = {
    ...existing,
    passwordHash,
    mustChangePassword,
    updatedAt: new Date().toISOString(),
  };
  await r.set(kAccount(teamMemberId), updated);
  return updated;
}

/** Updates only the email field, leaving username, password, and
 *  mustChangePassword intact. Pass an empty string to clear the email.
 *  Throws on a malformed address. */
export async function updateAccountEmail(
  teamMemberId: string,
  email: string,
): Promise<BarberAccountRecord | null> {
  const r = getRedis();
  const existing = await getAccount(teamMemberId);
  if (!existing) return null;
  const trimmed = email.trim();
  let nextEmail: string | undefined;
  if (trimmed === '') {
    nextEmail = undefined;
  } else {
    const normalized = normalizeEmail(trimmed);
    if (normalized === null) {
      throw new Error('email is not a valid address');
    }
    nextEmail = normalized;
  }
  const updated: BarberAccountRecord = {
    ...existing,
    ...(nextEmail ? { email: nextEmail } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (!nextEmail) delete updated.email;
  await r.set(kAccount(teamMemberId), updated);
  return updated;
}

export async function deleteAccount(teamMemberId: string): Promise<void> {
  const r = getRedis();
  const existing = await getAccount(teamMemberId);
  if (existing?.username) await r.del(kUsername(existing.username));
  await r.del(kAccount(teamMemberId));
  await r.srem(KEY_INDEX, teamMemberId);
}

/** Returns all provisioned accounts. Used by the admin barbers page so
 *  Michael can see who has a login and who doesn't. */
export async function listAccounts(): Promise<BarberAccountRecord[]> {
  const r = getRedis();
  const ids = await r.smembers(KEY_INDEX);
  if (!ids || ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => getAccount(id)));
  const out: BarberAccountRecord[] = [];
  for (const rec of records) if (rec) out.push(rec);
  return out;
}
