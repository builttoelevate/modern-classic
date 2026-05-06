// Phase 9 — shared "find matching openings for a waitlist entry" helper.
//
// Used by:
//   1. /api/cron/waitlist-notify — first-match short-circuit for the
//      auto-notify email loop.
//   2. /admin/waitlist — multi-match list rendered inline under each
//      active entry so the owner can book or email about a specific
//      slot without leaving the page.
//
// Both call sites used to roll their own. This module collapses the
// Square fetch + the matcher into one entry-driven helper.

import { searchAvailability } from '../square/availability';
import { findMatchingSlotsForEntry } from './waitlistMatch';
import type { AvailabilitySlot } from '../square/types';
import type { WaitlistEntry } from './waitlistLog';

/** Square's availability endpoint caps each call at 31 days. We chunk the
 * customer's window into ≤30-day pieces so we never overshoot. */
const CHUNK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Bounded scan in case the cron has been off — never look further out
 * than this from "now" regardless of dateTo. Square only takes bookings
 * a couple of months ahead anyway. */
const MAX_HORIZON_DAYS = 90;

/**
 * Resolve the [startAt, endAt] window we should ask Square about for a
 * given entry. Lower bound: max(now, dateFrom local-midnight). Upper
 * bound: min(now + MAX_HORIZON_DAYS, dateTo local-end-of-day). Returns
 * null when the window is empty / already fully in the past.
 */
export function searchWindowFor(
  entry: WaitlistEntry,
  now: Date,
): { startAt: Date; endAt: Date } | null {
  const nowMs = now.getTime();
  let startMs = nowMs;
  if (entry.dateFrom) {
    const fromMs = Date.parse(`${entry.dateFrom}T00:00:00`);
    if (Number.isFinite(fromMs) && fromMs > nowMs) startMs = fromMs;
  }
  let endMs = nowMs + MAX_HORIZON_DAYS * DAY_MS;
  if (entry.dateTo) {
    const toMs = Date.parse(`${entry.dateTo}T23:59:59`);
    if (Number.isFinite(toMs) && toMs < endMs) endMs = toMs;
  }
  if (endMs <= startMs) return null;
  return { startAt: new Date(startMs), endAt: new Date(endMs) };
}

interface ChunkedSearchOptions {
  serviceVariationId: string;
  teamMemberId?: string;
  startAt: Date;
  endAt: Date;
  /** When set, stops fetching further chunks once `out.length >= stopAfter`.
   * The cron passes 1 (first match short-circuits); the admin passes the
   * limit it wants to render so we don't burn extra Square calls. */
  stopAfter?: number;
}

export async function searchAvailabilityChunked(
  opts: ChunkedSearchOptions,
): Promise<AvailabilitySlot[]> {
  const { serviceVariationId, teamMemberId, startAt, endAt, stopAfter } = opts;
  const out: AvailabilitySlot[] = [];
  let cursor = startAt.getTime();
  const endMs = endAt.getTime();
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_DAYS * DAY_MS, endMs);
    const slots = await searchAvailability({
      serviceVariationId,
      teamMemberId,
      startAt: new Date(cursor),
      endAt: new Date(chunkEnd),
    });
    out.push(...slots);
    cursor = chunkEnd;
    if (typeof stopAfter === 'number' && out.length >= stopAfter) break;
  }
  return out;
}

interface SuggestOptions {
  /** Maximum slots to return. Defaults to 5. */
  limit?: number;
  /** Defaults to `new Date()`. Injected for tests. */
  now?: Date;
}

/**
 * Fetch up to `limit` Square slots that match a waitlist entry's
 * preferences (barber, service, date range, days-of-week, time band,
 * per-slot dedup). Used by the admin waitlist page to render an inline
 * list of openings under each active entry.
 *
 * Returns `[]` (never throws on shape) when:
 *   - the entry has no `serviceVariationId` (legacy entry)
 *   - the entry's date window is entirely in the past
 *
 * Square API errors propagate so the caller can render a per-entry
 * "couldn't load openings" inline error without blanking the whole page.
 */
export async function findMatchingSlotsForEntryFromSquare(
  entry: WaitlistEntry,
  opts: SuggestOptions = {},
): Promise<AvailabilitySlot[]> {
  if (!entry.serviceVariationId) return [];
  const now = opts.now ?? new Date();
  const window = searchWindowFor(entry, now);
  if (!window) return [];

  const limit = Math.max(1, opts.limit ?? 5);
  // Pull a few extra raw slots before filtering — the matcher's prefs
  // (days-of-week, time band, dedup) can knock out a meaningful chunk
  // of what Square returns. Capped so we still bail out of further
  // chunks once we have enough raw candidates.
  const slots = await searchAvailabilityChunked({
    serviceVariationId: entry.serviceVariationId,
    teamMemberId: entry.teamMemberId ?? undefined,
    startAt: window.startAt,
    endAt: window.endAt,
    stopAfter: limit * 4,
  });
  return findMatchingSlotsForEntry(entry, slots, { limit });
}
