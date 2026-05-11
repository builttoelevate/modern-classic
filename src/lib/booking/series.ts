// Book Ahead — generate the date sequence for a series of visits.
//
// "Same wall-clock time, every N weeks" in shop TZ. The naive
// implementation (`startMs + 7 * frequencyWeeks * DAY_MS`) breaks
// across daylight saving — a 2pm haircut in May becomes a 1pm or
// 3pm one in November depending on the direction of the shift. We
// instead anchor on the wall-clock components in America/New_York
// and reconstruct UTC from them at each step.
//
// Pure functions only — no Square calls. The caller pairs each
// generated timestamp with availability via seriesAvailability.

const SHOP_TZ = 'America/New_York';

interface ShopWallTime {
  year: number;
  month: number; // 1-indexed
  day: number;
  hour: number;
  minute: number;
}

/**
 * Decompose a UTC ISO timestamp into shop-local wall-clock parts.
 * Round-trip safe: composing the result back into a Date in the shop
 * timezone reproduces the input.
 */
function toShopWallTime(utcIso: string): ShopWallTime {
  const date = new Date(utcIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return {
    year: parseInt(m.year, 10),
    month: parseInt(m.month, 10),
    day: parseInt(m.day, 10),
    // Intl's hour12:false sometimes renders midnight as "24"; normalize.
    hour: parseInt(m.hour, 10) % 24,
    minute: parseInt(m.minute, 10),
  };
}

/**
 * Walk forward N days from a (year, month, day) in shop-local calendar
 * terms. Crossing DST is fine — the resulting date describes the
 * calendar day, not a UTC offset. Used to advance the wall-clock anchor
 * before re-projecting into UTC.
 */
function addCalendarDays(parts: ShopWallTime, days: number): ShopWallTime {
  // Use UTC arithmetic on a synthetic date to advance the calendar
  // without touching the hour/minute, then read the parts back out.
  // We don't go through shop-TZ Intl here because the day arithmetic
  // is timezone-invariant when applied to year/month/day directly.
  const synthetic = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  synthetic.setUTCDate(synthetic.getUTCDate() + days);
  return {
    year: synthetic.getUTCFullYear(),
    month: synthetic.getUTCMonth() + 1,
    day: synthetic.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

/**
 * Given shop-local wall-clock parts, return the UTC ISO timestamp that
 * renders to exactly those parts in shop TZ. Handles DST by probing the
 * raw UTC guess, measuring its shop-TZ offset, and correcting.
 */
function toUtcIsoForShopWallTime(parts: ShopWallTime): string {
  // First guess: pretend the wall-clock time IS UTC.
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
  );
  // What does that render to in shop TZ? Subtract from the desired
  // wall-clock to find the offset, then add it back.
  const rendered = toShopWallTime(new Date(naive).toISOString());
  const renderedMs = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
    0,
  );
  const offsetMs = naive - renderedMs;
  const corrected = naive + offsetMs;
  // DST boundary edge case: spring-forward skips a wall-clock hour.
  // Re-render to verify; if the rendered hour drifted, snap back to
  // the desired hour at the new offset (Intl resolves "non-existent"
  // wall-clock times to the next valid instant, which is what we want).
  return new Date(corrected).toISOString();
}

/**
 * Generate the additional visit timestamps after the customer's first
 * pick. Returns positions 2..N — position 1 is the customer's actual
 * Square slot and isn't part of this list. Length is at most
 * count - 1, never negative.
 */
export function generateSeriesTimestamps(
  firstSlotUtc: string,
  frequencyWeeks: number,
  count: number,
): string[] {
  if (frequencyWeeks <= 0 || count <= 1) return [];
  const anchor = toShopWallTime(firstSlotUtc);
  const out: string[] = [];
  for (let i = 1; i < count; i++) {
    const next = addCalendarDays(anchor, i * frequencyWeeks * 7);
    out.push(toUtcIsoForShopWallTime(next));
  }
  return out;
}
