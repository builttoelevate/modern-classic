// Phase 8 — waitlist bookkeeping in Upstash Redis.
//
// Customers submit /api/waitlist when no calendar slot works. The endpoint
// emails the shop (existing behavior) AND now also persists the entry in
// KV so the admin /admin/waitlist page can list, status-track, and act on
// them without depending on the shop's email inbox as the system of record.
//
// Status lifecycle:
//   new       — submitted by customer, not yet seen by shop
//   contacted — shop reached out (call / text / email)
//   booked    — shop scheduled them an appointment
//   archived  — no action needed, hide from default view
//
// Entries TTL at 6 months. Plenty of time for shop to action; keeps KV
// bounded if traffic grows.

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
      'Upstash Redis is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel injects these when an Upstash KV store is connected).',
    );
  }
  _redis = new Redis({ url: String(url), token: String(token) });
  return _redis;
}

export type WaitlistStatus = 'new' | 'contacted' | 'booked' | 'archived';

export interface WaitlistEntry {
  id: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  barberName: string;
  /** Square IDs if we resolved them at submit time — used for the
   * "Schedule" deep-link from admin. May be null on older entries. */
  serviceVariationId: string | null;
  teamMemberId: string | null;
  preferredDate?: string;
  note?: string;
  submittedAt: string;
  status: WaitlistStatus;
  /** Free-text the admin types when marking contacted/booked. */
  adminNote?: string;
  /** ISO of the last status change. */
  statusChangedAt?: string;
}

const KEY_PREFIX = 'mc:waitlist:';
const TTL_SECONDS = 60 * 60 * 24 * 180; // 6 months

function kEntry(id: string): string {
  return `${KEY_PREFIX}entry:${id}`;
}
function kIndex(): string {
  return `${KEY_PREFIX}index`;
}

function newId(): string {
  // Short, sortable, no PII. Timestamp + 5 random base36 chars is plenty
  // for the volumes a single-shop waitlist will ever see.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}-${rand}`;
}

export interface RecordWaitlistInput {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  barberName: string;
  serviceVariationId: string | null;
  teamMemberId: string | null;
  preferredDate?: string;
  note?: string;
}

export async function recordWaitlistEntry(
  input: RecordWaitlistInput,
): Promise<WaitlistEntry> {
  const redis = getRedis();
  const submittedAt = new Date().toISOString();
  const entry: WaitlistEntry = {
    id: newId(),
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    serviceName: input.serviceName,
    barberName: input.barberName,
    serviceVariationId: input.serviceVariationId,
    teamMemberId: input.teamMemberId,
    preferredDate: input.preferredDate,
    note: input.note,
    submittedAt,
    status: 'new',
    statusChangedAt: submittedAt,
  };
  await Promise.all([
    redis.set(kEntry(entry.id), entry, { ex: TTL_SECONDS }),
    redis.zadd(kIndex(), { score: Date.now(), member: entry.id }),
  ]);
  return entry;
}

export async function listWaitlistEntries(opts: {
  limit?: number;
  includeArchived?: boolean;
} = {}): Promise<WaitlistEntry[]> {
  const redis = getRedis();
  const limit = opts.limit ?? 100;
  // ZRANGE with REV pulls newest first.
  const ids = await redis.zrange<string[]>(kIndex(), 0, limit - 1, { rev: true });
  if (!ids || ids.length === 0) return [];
  const entries = await Promise.all(
    ids.map((id) => redis.get<WaitlistEntry>(kEntry(id))),
  );
  const out: WaitlistEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (!opts.includeArchived && e.status === 'archived') continue;
    out.push(e);
  }
  return out;
}

export async function getWaitlistEntry(id: string): Promise<WaitlistEntry | null> {
  const redis = getRedis();
  const e = await redis.get<WaitlistEntry>(kEntry(id));
  return e ?? null;
}

export interface UpdateStatusInput {
  id: string;
  status: WaitlistStatus;
  adminNote?: string;
}

export async function updateWaitlistStatus(
  input: UpdateStatusInput,
): Promise<WaitlistEntry | null> {
  const redis = getRedis();
  const existing = await redis.get<WaitlistEntry>(kEntry(input.id));
  if (!existing) return null;
  const updated: WaitlistEntry = {
    ...existing,
    status: input.status,
    adminNote: input.adminNote ?? existing.adminNote,
    statusChangedAt: new Date().toISOString(),
  };
  await redis.set(kEntry(input.id), updated, { keepTtl: true });
  return updated;
}

export async function countWaitlistByStatus(): Promise<Record<WaitlistStatus, number>> {
  const all = await listWaitlistEntries({ limit: 500, includeArchived: true });
  const counts: Record<WaitlistStatus, number> = {
    new: 0,
    contacted: 0,
    booked: 0,
    archived: 0,
  };
  for (const e of all) counts[e.status]++;
  return counts;
}
