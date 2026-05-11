// Book Ahead — resolve each generated timestamp against Square's
// real availability for the locked barber + service variation.
//
// For each intended timestamp we ask /api/square/availability for the
// shop-local day containing that timestamp and look for a slot whose
// startAtUtc matches. Three outcomes per intended slot:
//   • match found      → status: 'available', slot: <the match>
//   • day has slots but
//     none at our time → status: 'taken'
//   • day has 0 slots  → status: 'barber-off'
// Slots past 365 days from now (server-side cap) come back empty too;
// the caller treats those as 'out-of-horizon' upstream.

import type { AvailabilitySlot } from '../square/types';
import type { GeneratedSlot } from '../../components/booking/wizardState';

const SHOP_TZ = 'America/New_York';
const HORIZON_DAYS = 365;

/**
 * Return the start-of-day (00:00) and start-of-next-day (00:00) UTC
 * timestamps for the shop-local day containing `utcIso`. Square caps
 * each availability range at 31 days — one day is comfortably under.
 */
function shopDayBoundsUtc(utcIso: string): { startAt: string; endAt: string } {
  // Reading the shop-local YYYY-MM-DD via Intl is the cleanest way to
  // figure out which calendar day a UTC moment lands on without doing
  // offset math by hand.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcIso));
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  // The Intl en-CA locale puts year-month-day in ISO order; rebuild a
  // YYYY-MM-DD and rely on Date.parse to anchor it to UTC midnight,
  // then walk back through shop TZ to find the actual UTC moment for
  // "shop-local midnight on that day".
  const localY = parseInt(m.year, 10);
  const localM = parseInt(m.month, 10);
  const localD = parseInt(m.day, 10);

  // Probe-and-correct to handle DST: pretend wall-clock midnight IS
  // UTC, see how shop TZ renders it, and shift by the offset.
  const probe = Date.UTC(localY, localM - 1, localD, 0, 0, 0);
  const rendered = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(probe));
  const r: Record<string, string> = {};
  for (const p of rendered) r[p.type] = p.value;
  const renderedMs = Date.UTC(
    parseInt(r.year, 10),
    parseInt(r.month, 10) - 1,
    parseInt(r.day, 10),
    parseInt(r.hour, 10) % 24,
    parseInt(r.minute, 10),
    0,
  );
  const offsetMs = probe - renderedMs;
  const dayStartMs = probe + offsetMs;
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  return {
    startAt: new Date(dayStartMs).toISOString(),
    endAt: new Date(dayEndMs).toISOString(),
  };
}

interface AvailabilityApiResponse {
  ok?: boolean;
  slots?: AvailabilitySlot[];
  error?: { code: string; detail: string };
}

async function fetchSlotsForDay(
  serviceVariationId: string,
  teamMemberId: string | undefined,
  startAt: string,
  endAt: string,
): Promise<AvailabilitySlot[] | null> {
  const params = new URLSearchParams({ serviceVariationId, startAt, endAt });
  if (teamMemberId) params.set('teamMemberId', teamMemberId);
  try {
    const res = await fetch(`/api/square/availability?${params.toString()}`);
    if (!res.ok) return null;
    const body = (await res.json()) as AvailabilityApiResponse;
    if (!body.ok) return null;
    return body.slots ?? [];
  } catch {
    return null;
  }
}

/**
 * Resolve N intended timestamps into GeneratedSlot rows the wizard's
 * Book Ahead panel can render. Fires one availability fetch per
 * unique day (multiple visits on the same day would dedupe, though
 * that doesn't happen with the current 2/3/4/6-week frequencies).
 * Failed fetches surface as 'barber-off' rather than blowing up — the
 * customer can still try Confirm on the available ones.
 */
export async function resolveSeriesAvailability(
  intendedTimestamps: string[],
  serviceVariationId: string,
  teamMemberId: string | undefined,
): Promise<GeneratedSlot[]> {
  const nowMs = Date.now();
  const horizonMs = nowMs + HORIZON_DAYS * 24 * 60 * 60 * 1000;

  // Group timestamps by their shop-local day so we fetch each day's
  // availability at most once even if two intended visits fall on the
  // same date (e.g. a hypothetical weekly cadence with 2 visits / week
  // — not in the current frequency menu but cheap to support).
  const dayBuckets = new Map<string, string[]>();
  for (const ts of intendedTimestamps) {
    const tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs) || tsMs > horizonMs) continue; // out-of-horizon handled below
    const { startAt } = shopDayBoundsUtc(ts);
    const bucket = dayBuckets.get(startAt) ?? [];
    bucket.push(ts);
    dayBuckets.set(startAt, bucket);
  }

  // Fetch every needed day in parallel.
  const dayFetches = await Promise.all(
    [...dayBuckets.entries()].map(async ([dayStartAt, _bucket]) => {
      const { endAt } = shopDayBoundsUtc(dayStartAt);
      const slots = await fetchSlotsForDay(
        serviceVariationId,
        teamMemberId,
        dayStartAt,
        endAt,
      );
      return [dayStartAt, slots] as const;
    }),
  );
  const slotsByDay = new Map(dayFetches);

  // Build the result in the original timestamp order.
  return intendedTimestamps.map<GeneratedSlot>((intended) => {
    const tsMs = Date.parse(intended);
    if (Number.isNaN(tsMs) || tsMs > horizonMs) {
      return {
        intendedStartAtUtc: intended,
        status: 'out-of-horizon',
        slot: null,
      };
    }
    const { startAt } = shopDayBoundsUtc(intended);
    const daySlots = slotsByDay.get(startAt);
    if (daySlots === null || daySlots === undefined) {
      // Fetch failed or barber off — collapse both to 'barber-off' for
      // PR 1; the inline alternatives picker in PR 2 will treat them
      // the same way (offer nearby days) so the user-visible split
      // here doesn't earn its keep yet.
      return { intendedStartAtUtc: intended, status: 'barber-off', slot: null };
    }
    if (daySlots.length === 0) {
      return { intendedStartAtUtc: intended, status: 'barber-off', slot: null };
    }
    const match = daySlots.find((s) => s.startAtUtc === intended) ?? null;
    if (match) {
      return { intendedStartAtUtc: intended, status: 'available', slot: match };
    }
    return { intendedStartAtUtc: intended, status: 'taken', slot: null };
  });
}

/**
 * Look up alternative slots for a Booking Plan row whose intended
 * time is taken or unavailable. Strategy:
 *
 *   1. Same shop-day as the target — sort the day's openings by
 *      proximity to the target time and return the top N. This is
 *      the common case ("you wanted 2pm, here's 1:30 / 2:30 / 3pm
 *      same day").
 *   2. If the day has zero openings (barber off, holiday), walk a
 *      7-day forward window from the day-after-target and return
 *      the soonest N slots in chronological order.
 *
 * Returns an empty array when nothing's bookable in either pass —
 * the popover surfaces that state as "No alternatives nearby."
 */
export async function findNearbyAlternatives(
  targetUtc: string,
  serviceVariationId: string,
  teamMemberId: string | undefined,
  count = 3,
): Promise<AvailabilitySlot[]> {
  const targetMs = Date.parse(targetUtc);
  if (Number.isNaN(targetMs)) return [];

  // Same-day pass.
  const dayBounds = shopDayBoundsUtc(targetUtc);
  const sameDay = await fetchSlotsForDay(
    serviceVariationId,
    teamMemberId,
    dayBounds.startAt,
    dayBounds.endAt,
  );
  if (sameDay && sameDay.length > 0) {
    return [...sameDay]
      .sort((a, b) => {
        const da = Math.abs(Date.parse(a.startAtUtc) - targetMs);
        const db = Math.abs(Date.parse(b.startAtUtc) - targetMs);
        return da - db;
      })
      .slice(0, count);
  }

  // Forward-7-day pass. Square caps each call at 31 days; 7 days is
  // comfortably under and keeps the popover decision fast.
  const dayMs = 24 * 60 * 60 * 1000;
  const forwardStart = Date.parse(dayBounds.endAt); // day after target's local day
  const forwardEnd = forwardStart + 7 * dayMs;
  if (Number.isNaN(forwardStart)) return [];
  const forward = await fetchSlotsForDay(
    serviceVariationId,
    teamMemberId,
    new Date(forwardStart).toISOString(),
    new Date(forwardEnd).toISOString(),
  );
  if (!forward || forward.length === 0) return [];
  return [...forward]
    .sort((a, b) => Date.parse(a.startAtUtc) - Date.parse(b.startAtUtc))
    .slice(0, count);
}
