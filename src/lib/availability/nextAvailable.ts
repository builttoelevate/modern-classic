// Phase 6 Part A — "next available" lookups, cached at 10 minutes.
//
// Three callers hit this:
//   • Rebook-your-usual on /my-bookings           (per-combo)
//   • /barbers cards                              (per-barber)
//   • Homepage hero (signed-in or guest)          (per-barber or any)

import { cached } from './cache';
import { searchAvailability } from '../square/availability';
import { getBarbers } from '../square/team';
import { getServices } from '../square/catalog';
import type { AvailabilitySlot, Barber, Service, ServiceVariation } from '../square/types';
import { isWithinDays } from './timing';
import { slugForService } from '../catalog/liveServices';

const CACHE_TTL_SECONDS = 600;
const SEARCH_WINDOW_DAYS = 365;
const WITHIN_DAYS_THRESHOLD = 7;
// Square's availability search throws on any range > 31 days.
// We chunk in 30-day windows and short-circuit on the first chunk
// that returns slots — for the "next opening" use case we only
// need the soonest, so most lookups bail after one chunk.
const CHUNK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function searchEnd(): Date {
  return new Date(Date.now() + SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function searchStart(): Date {
  // Search starts "now"; Square's lead-time policy will exclude any
  // slots too close to wall-clock time.
  return new Date();
}

/**
 * Slugs whose variations count as a "haircut" opening for the purposes of
 * the homepage and /barbers barber cards. Excludes pure beard work,
 * shaves, and shampoos so a 15-min Beard Trim or Shampoo+Style block
 * doesn't surface as the barber's "Next available".
 *
 * Includes haircut-beard because that service still produces a fresh
 * cut — the point is to advertise an opening for someone who wants their
 * hair cut, with or without a beard pass.
 */
export const HAIRCUT_SLUGS = new Set([
  'mens-haircut',
  'kids-haircut',
  'haircut-design',
  'new-customer',
  'haircut-beard',
]);

/**
 * Pick the variations for a given barber that we should query. We prefer
 * Men's Haircut variations first (most common), then any other variation
 * the barber serves. Returns at most 2 variations to avoid hammering
 * Square with parallel calls per barber.
 *
 * When `kind === 'haircut'`, only variations whose parent service is a
 * haircut-style service are considered (see HAIRCUT_SLUGS above).
 */
function variationsForBarber(
  services: Service[],
  barberId: string,
  kind: 'haircut' | 'any' = 'any',
): ServiceVariation[] {
  // Build a set of service IDs whose slug is in the haircut allowlist.
  // Done once up front so we can filter the variation loop below.
  const haircutServiceIds = new Set<string>();
  if (kind === 'haircut') {
    for (const s of services) {
      const copy = slugForService(s);
      if (HAIRCUT_SLUGS.has(copy.slug)) haircutServiceIds.add(s.id);
    }
  }

  const candidates: ServiceVariation[] = [];
  for (const s of services) {
    if (kind === 'haircut' && !haircutServiceIds.has(s.id)) continue;
    for (const v of s.variations) {
      if (!v.availableForBooking) continue;
      if (v.eligibleTeamMemberIds.includes(barberId)) {
        candidates.push(v);
      }
    }
  }
  // Prefer the shortest non-variable-priced variations first — those have
  // the most open slots. Tiebreak by stable variation id.
  candidates.sort((a, b) => {
    if (a.priceCents === null && b.priceCents !== null) return 1;
    if (a.priceCents !== null && b.priceCents === null) return -1;
    if (a.durationMinutes !== b.durationMinutes) return a.durationMinutes - b.durationMinutes;
    return a.id.localeCompare(b.id);
  });
  return candidates.slice(0, 2);
}

async function computeNextForBarber(
  barberId: string,
  services: Service[],
  kind: 'haircut' | 'any' = 'any',
): Promise<AvailabilitySlot | null> {
  const variations = variationsForBarber(services, barberId, kind);
  if (variations.length === 0) return null;
  const startMs = searchStart().getTime();
  const endMs = searchEnd().getTime();

  // Walk forward in 30-day chunks until we find the first chunk with
  // any slot for ANY of the candidate variations. Most lookups bail
  // after one chunk because the soonest slot is almost always within
  // a few weeks. The horizon goes out to 365 days for the rare case
  // where every variation is fully booked for months — chunking +
  // early-exit keeps the common case fast.
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_DAYS * DAY_MS, endMs);
    const results = await Promise.all(
      variations.map((v) =>
        searchAvailability({
          serviceVariationId: v.id,
          teamMemberId: barberId,
          startAt: new Date(cursor),
          endAt: new Date(chunkEnd),
        }).catch(() => [] as AvailabilitySlot[]),
      ),
    );
    let soonest: AvailabilitySlot | null = null;
    for (const slots of results) {
      for (const s of slots) {
        if (!soonest || s.startAtUtc < soonest.startAtUtc) {
          soonest = s;
        }
      }
    }
    if (soonest) return soonest;
    cursor = chunkEnd;
  }
  return null;
}

export interface NextAvailability {
  slot: AvailabilitySlot | null;
  withinSevenDays: boolean;
}

export interface NextAvailabilityOpts {
  /** Restrict the variation search to haircut-style services only. */
  kind?: 'haircut' | 'any';
}

export async function getNextAvailability(
  barberId: string,
  opts: NextAvailabilityOpts = {},
): Promise<NextAvailability> {
  const kind = opts.kind ?? 'any';
  return cached(`next-avail:${barberId}:${kind}`, CACHE_TTL_SECONDS, async () => {
    const services = await getServices();
    const slot = await computeNextForBarber(barberId, services, kind);
    return {
      slot,
      withinSevenDays: slot ? isWithinDays(slot.startAtUtc, WITHIN_DAYS_THRESHOLD) : false,
    };
  });
}

export interface ComboSlotsInput {
  serviceVariationId: string;
  teamMemberId: string;
  count: number;
}

export async function getNextSlotsForCombo(
  input: ComboSlotsInput,
): Promise<AvailabilitySlot[]> {
  const key = `combo-slots:${input.serviceVariationId}:${input.teamMemberId}:${input.count}`;
  return cached(key, CACHE_TTL_SECONDS, async () => {
    // Same chunking strategy as computeNextForBarber — Square caps
    // range at 31 days, and we want enough slots to satisfy count.
    // Walk forward in 30-day chunks, accumulating until we have
    // enough or hit the horizon.
    const want = Math.max(1, input.count);
    const out: AvailabilitySlot[] = [];
    const startMs = searchStart().getTime();
    const endMs = searchEnd().getTime();
    let cursor = startMs;
    while (cursor < endMs && out.length < want) {
      const chunkEnd = Math.min(cursor + CHUNK_DAYS * DAY_MS, endMs);
      const slots = await searchAvailability({
        serviceVariationId: input.serviceVariationId,
        teamMemberId: input.teamMemberId,
        startAt: new Date(cursor),
        endAt: new Date(chunkEnd),
      }).catch(() => [] as AvailabilitySlot[]);
      out.push(...slots);
      cursor = chunkEnd;
    }
    return out.slice(0, want);
  });
}

export interface SoonestAcrossBarbers {
  barber: Barber;
  slot: AvailabilitySlot;
}

export interface SoonestAcrossBarbersOpts {
  /** Restrict the variation search to haircut-style services only. */
  kind?: 'haircut' | 'any';
}

export async function getSoonestAcrossBarbers(
  opts: SoonestAcrossBarbersOpts = {},
): Promise<SoonestAcrossBarbers | null> {
  const kind = opts.kind ?? 'any';
  return cached(`soonest-across-barbers:${kind}`, CACHE_TTL_SECONDS, async () => {
    const [barbers, services] = await Promise.all([getBarbers(), getServices()]);
    const perBarber = await Promise.all(
      barbers.map(async (b) => ({
        barber: b,
        slot: await computeNextForBarber(b.id, services, kind),
      })),
    );
    let best: SoonestAcrossBarbers | null = null;
    for (const entry of perBarber) {
      if (!entry.slot) continue;
      if (!best || entry.slot.startAtUtc < best.slot.startAtUtc) {
        best = { barber: entry.barber, slot: entry.slot };
      }
    }
    return best;
  });
}
