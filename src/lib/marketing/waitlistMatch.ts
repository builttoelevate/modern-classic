// Phase 8 — pure matcher that decides whether a waitlist entry should be
// notified about any of the slots Square just returned. No I/O — easy to
// reason about and easy to drop into a unit test later.

import type { AvailabilitySlot } from '../square/types';
import type { WaitlistEntry } from './waitlistLog';

const SHOP_TZ = 'America/New_York';

const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  weekday: 'short',
});
const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  hour: '2-digit',
  hour12: false,
});

const DOW_LOOKUP: Record<string, string> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Local time band a slot's hour belongs to.
 *   morning   < 12
 *   afternoon 12 ≤ h < 15
 *   evening   ≥ 15
 *
 * Threshold lives here AND in WaitlistSheet's TIME_OPTIONS sub-labels —
 * keep them in sync so the chip a customer toggles ("3pm +") agrees
 * with the band the matcher assigns to a slot.
 */
function bandFor(hour24: number): 'morning' | 'afternoon' | 'evening' {
  if (hour24 < 12) return 'morning';
  if (hour24 < 15) return 'afternoon';
  return 'evening';
}

function dayOfWeekFor(slot: AvailabilitySlot): string {
  const utc = new Date(slot.startAtUtc);
  const short = DAY_FMT.format(utc); // 'Mon', 'Tue', ...
  return DOW_LOOKUP[short] ?? '';
}

function hourFor(slot: AvailabilitySlot): number {
  const utc = new Date(slot.startAtUtc);
  // Intl returns '00'..'23' with hour12:false. Some locales use '24'
  // for midnight at certain timezones; normalize defensively.
  const raw = HOUR_FMT.format(utc);
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n === 24 ? 0 : n;
}

/**
 * Returns the first slot the entry should be notified about, or null.
 *
 * Skips:
 *   - Any slot if the entry was notified within COOLDOWN_MS.
 *   - The exact slot already notified about (per-slot dedup).
 *   - Slots whose local date is outside [dateFrom, dateTo].
 *   - Slots whose local day-of-week isn't in daysOfWeek (when set + non-empty).
 *   - Slots whose local hour band isn't in timesOfDay (when set + non-empty).
 */
export function findMatchingSlot(
  entry: WaitlistEntry,
  slots: AvailabilitySlot[],
  now: Date = new Date(),
): AvailabilitySlot | null {
  if (entry.lastNotifiedAt) {
    const last = new Date(entry.lastNotifiedAt).getTime();
    if (Number.isFinite(last) && now.getTime() - last < COOLDOWN_MS) return null;
  }

  const dateFrom = entry.dateFrom?.trim() || null;
  const dateTo = entry.dateTo?.trim() || null;
  const daysFilter =
    entry.daysOfWeek && entry.daysOfWeek.length > 0 ? new Set(entry.daysOfWeek) : null;
  const timesFilter =
    entry.timesOfDay && entry.timesOfDay.length > 0 ? new Set(entry.timesOfDay) : null;

  // Slots from searchAvailability are already sorted earliest-first, but
  // sort defensively so the matcher's contract doesn't depend on caller.
  const sorted = [...slots].sort((a, b) => a.startAtUtc.localeCompare(b.startAtUtc));

  for (const slot of sorted) {
    if (entry.notifiedSlotStartAtUtc && slot.startAtUtc === entry.notifiedSlotStartAtUtc) {
      continue;
    }
    if (dateFrom && slot.dateKey < dateFrom) continue;
    if (dateTo && slot.dateKey > dateTo) continue;

    if (daysFilter) {
      const dow = dayOfWeekFor(slot);
      if (!dow || !daysFilter.has(dow)) continue;
    }

    if (timesFilter) {
      const band = bandFor(hourFor(slot));
      if (!timesFilter.has(band)) continue;
    }

    return slot;
  }
  return null;
}

/**
 * Phase 8 — true when the entry's preferred date window has fully
 * passed (i.e. the cron should auto-archive it). Compares dateTo to
 * today's date in shop tz. Returns false when no dateTo is set.
 */
export function isWindowExpired(entry: WaitlistEntry, now: Date = new Date()): boolean {
  if (!entry.dateTo) return false;
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // en-CA produces 'YYYY-MM-DD' which is directly comparable to dateTo.
  return entry.dateTo < todayKey;
}
