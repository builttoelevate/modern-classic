// Group booking availability — finds slots that satisfy 2–4 people
// booking together in one of two scheduling modes.
//
// The single-booking flow asks Square "is barber X free for service Y at
// time T?" and renders the answer. Group bookings need joint feasibility
// across N people, which Square's availability endpoint doesn't model
// directly. We do the cross-person work here in app code on top of the
// per-(barber, service) slot lists Square already returns.

import { searchAvailability } from '../square/availability';
import type { AvailabilitySlot, ServiceVariation } from '../square/types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Square caps /v2/bookings/availability/search at 31 days per call.
 * We chunk longer windows into ≤30-day pieces and concatenate the
 * results so the matcher can search further out without tripping the
 * API's range limit. */
const CHUNK_DAYS = 30;

/** Run a single (variation, barber) availability search across an
 * arbitrary date range, chunking under Square's 31-day per-call cap.
 * Each chunk's slots are concatenated in order so callers see a flat
 * list. Failures on any single chunk return [] for that chunk only —
 * the rest still contribute, which keeps a partial Square hiccup from
 * blanking the whole picker. */
async function searchVariationBarber(
  variationId: string,
  teamMemberId: string,
  range: SearchRange,
): Promise<AvailabilitySlot[]> {
  const out: AvailabilitySlot[] = [];
  let cursor = range.startAt.getTime();
  const endMs = range.endAt.getTime();
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_DAYS * DAY_MS, endMs);
    try {
      const slots = await searchAvailability({
        serviceVariationId: variationId,
        teamMemberId,
        startAt: new Date(cursor),
        endAt: new Date(chunkEnd),
      });
      out.push(...slots);
    } catch {
      // Skip this chunk; its absence at worst hides a few days of
      // openings rather than crashing the wizard. Per-(variation,
      // barber) failures already get swallowed by Promise.allSettled
      // upstream — this is the inner per-chunk equivalent.
    }
    cursor = chunkEnd;
  }
  return out;
}

/** Each member of the group. The wizard collects N of these (2–4). */
export interface GroupMember {
  /** UI-only stable id — used to key the React list. */
  key: string;
  /** Display name for the booking note (Tommy, Jake, mom, etc.). */
  displayName: string;
  /** Every variation of the picked service that this member could
   * potentially book. Square models "Men's Haircut" as N variations
   * (one per barber) when prices/durations differ between barbers, so
   * the eligible barber set is the union across these variations. The
   * matcher resolves which specific variation to use per (member,
   * barber) pair at slot-pick time. */
  variations: ServiceVariation[];
  /** Union of `eligibleTeamMemberIds` across every variation the
   * member could book. Always at least one. */
  eligibleBarberIds: string[];
}

export interface AllAtOnceSlot {
  mode: 'all-at-once';
  /** ISO UTC string — the moment every member starts. Shorter services
   * finish earlier; the family waits in the lobby. */
  startAtUtc: string;
  /** YYYY-MM-DD in shop tz, for the calendar grouping. */
  dateKey: string;
  /** Per-member assignment in the same order as the GroupMember array.
   * Each entry names the barber that member is paired with at this slot. */
  assignments: Array<{
    memberKey: string;
    teamMemberId: string;
    serviceVariationId: string;
    durationMinutes: number;
  }>;
}

export interface BackToBackSlot {
  mode: 'back-to-back';
  /** ISO UTC string — when the FIRST member starts. */
  startAtUtc: string;
  dateKey: string;
  teamMemberId: string;
  /** Per-member offset + service. Each starts when the previous ends. */
  segments: Array<{
    memberKey: string;
    startAtUtc: string;
    serviceVariationId: string;
    durationMinutes: number;
  }>;
}

export type GroupSlot = AllAtOnceSlot | BackToBackSlot;

interface SearchRange {
  startAt: Date;
  endAt: Date;
}

/** For per-barber services like "Men's Haircut", Square has a separate
 * variation per barber and each variation lists only that one barber.
 * So we resolve the variation per (member, barber) pair: for each
 * member, find the variation in their `variations` list that the given
 * barber is eligible for. Returns null if no variation matches the
 * pairing (the barber can't do anything in this member's service). */
function variationFor(member: GroupMember, teamMemberId: string): ServiceVariation | null {
  for (const v of member.variations) {
    if (v.eligibleTeamMemberIds.includes(teamMemberId)) return v;
  }
  return null;
}

/** Pull every per-(variation, barber) slot list we need for the group
 * in parallel, returning a Map keyed by `${variationId}|${teamMemberId}`
 * for O(1) lookup. */
async function fetchSlotMatrix(
  variationToBarbers: Map<string, Set<string>>,
  range: SearchRange,
): Promise<Map<string, AvailabilitySlot[]>> {
  const tasks: Array<Promise<readonly [string, AvailabilitySlot[]]>> = [];
  for (const [variationId, barberIds] of variationToBarbers) {
    for (const teamMemberId of barberIds) {
      tasks.push(
        searchVariationBarber(variationId, teamMemberId, range).then(
          (slots) => [`${variationId}|${teamMemberId}`, slots] as const,
        ),
      );
    }
  }
  const settled = await Promise.allSettled(tasks);
  const out = new Map<string, AvailabilitySlot[]>();
  for (const r of settled) {
    if (r.status === 'fulfilled') out.set(r.value[0], r.value[1]);
  }
  return out;
}

/**
 * Bipartite assignment: for the candidate start time T and each member,
 * we have a set of barbers that are free at T for that member's service.
 * Find an assignment of distinct barbers to members that satisfies all.
 *
 * For N ≤ 4 simple recursive backtracking is overkill in performance but
 * dead-simple to read and verify. Returns null when no assignment exists.
 */
function assignBarbers(
  members: GroupMember[],
  freeAt: Array<{ memberKey: string; candidates: string[] }>,
): Array<{ memberKey: string; teamMemberId: string }> | null {
  const used = new Set<string>();
  const out: Array<{ memberKey: string; teamMemberId: string }> = [];

  // Order members by candidate-count ascending — fewest options first
  // so contradictions surface quickly.
  const order = freeAt
    .map((f, i) => ({ ...f, idx: i }))
    .sort((a, b) => a.candidates.length - b.candidates.length);

  function recurse(i: number): boolean {
    if (i === order.length) return true;
    const { memberKey, candidates } = order[i];
    for (const barberId of candidates) {
      if (used.has(barberId)) continue;
      used.add(barberId);
      out.push({ memberKey, teamMemberId: barberId });
      if (recurse(i + 1)) return true;
      used.delete(barberId);
      out.pop();
    }
    return false;
  }

  if (!recurse(0)) return null;
  // Re-key out by the original member order so callers can zip with
  // members[] without resorting.
  const byMember = new Map(out.map((a) => [a.memberKey, a.teamMemberId]));
  return members.map((m) => ({
    memberKey: m.key,
    teamMemberId: byMember.get(m.key)!,
  }));
}

interface FindOptions {
  /** Defaults to "now" plus Square's 1-hour minimum lead time. */
  startAt?: Date;
  /** How far out to search. Defaults to 30 days, capped by Square. */
  windowDays?: number;
  /** Maximum slots to return; the wizard only renders a handful per day. */
  limit?: number;
}

/**
 * "All at once" mode — every group member starts at the same minute,
 * each paired with a different barber qualified for their service.
 *
 * A start time T is valid when, for every member, at least one barber
 * eligible for that member's variation has T in their slot list AND
 * the per-member candidates can be assigned to distinct barbers
 * (a perfect matching exists in the bipartite "members × free barbers"
 * graph).
 *
 * Trip-wires:
 *   - same service across members is OK; we just need N distinct
 *     barbers free at T for that variation.
 *   - mixed services with overlapping barbers is OK; the assigner
 *     handles the resource-contention case.
 */
export async function findGroupSlotsAllAtOnce(
  members: GroupMember[],
  opts: FindOptions = {},
): Promise<AllAtOnceSlot[]> {
  if (members.length < 2) return [];

  const range: SearchRange = {
    startAt: opts.startAt ?? new Date(Date.now() + 60 * 60 * 1000),
    endAt: new Date(
      (opts.startAt ?? new Date()).getTime() + (opts.windowDays ?? 90) * DAY_MS,
    ),
  };

  // Build the (variation, barber) cross-product we need to query.
  // For each member, ask Square for slots only on the (variation, barber)
  // pairings where that barber is actually eligible for that variation —
  // querying a barber against a variation they can't do returns no slots
  // and burns an API call.
  const variationToBarbers = new Map<string, Set<string>>();
  for (const m of members) {
    for (const v of m.variations) {
      const set = variationToBarbers.get(v.id) ?? new Set<string>();
      for (const id of v.eligibleTeamMemberIds) {
        if (m.eligibleBarberIds.includes(id)) set.add(id);
      }
      if (set.size > 0) variationToBarbers.set(v.id, set);
    }
  }
  const matrix = await fetchSlotMatrix(variationToBarbers, range);

  // For each candidate start time, collect the per-member set of free
  // barbers and run the assignment check.
  // Candidate T's = union of every slot.startAtUtc across the matrix —
  // no point checking a time no one can possibly cover.
  const candidateTimes = new Set<string>();
  for (const slots of matrix.values()) {
    for (const s of slots) candidateTimes.add(s.startAtUtc);
  }

  const out: AllAtOnceSlot[] = [];
  const limit = Math.max(1, opts.limit ?? 200);

  // Sort candidates earliest-first so the calendar shows the soonest
  // options at the top of each day.
  const sortedTimes = [...candidateTimes].sort();
  for (const t of sortedTimes) {
    // For each member, the set of barbers free at T is the union over
    // every variation in m.variations of "barbers with a slot at T for
    // this variation". A barber is "free for member M at T" if any
    // qualifying variation has a slot at T.
    const perMemberCandidates: Array<{ memberKey: string; candidates: string[] }> = [];
    // Track which variation each (member, barber) pair would resolve to —
    // needed when we materialize the chosen assignment into a concrete
    // booking.
    const pairToVariation = new Map<string, ServiceVariation>();
    let feasible = true;
    for (const m of members) {
      const candidates = new Set<string>();
      for (const v of m.variations) {
        for (const barberId of v.eligibleTeamMemberIds) {
          if (!m.eligibleBarberIds.includes(barberId)) continue;
          const slots = matrix.get(`${v.id}|${barberId}`);
          if (!slots) continue;
          if (slots.some((s) => s.startAtUtc === t)) {
            candidates.add(barberId);
            // Record the variation for this (member, barber) pair only
            // once — first match wins, which for per-barber services is
            // the only match anyway.
            const key = `${m.key}|${barberId}`;
            if (!pairToVariation.has(key)) pairToVariation.set(key, v);
          }
        }
      }
      if (candidates.size === 0) {
        feasible = false;
        break;
      }
      perMemberCandidates.push({ memberKey: m.key, candidates: [...candidates] });
    }
    if (!feasible) continue;

    const assignment = assignBarbers(members, perMemberCandidates);
    if (!assignment) continue;

    out.push({
      mode: 'all-at-once',
      startAtUtc: t,
      dateKey: dateKeyFor(t),
      assignments: assignment.map((a) => {
        const v = pairToVariation.get(`${a.memberKey}|${a.teamMemberId}`)!;
        return {
          memberKey: a.memberKey,
          teamMemberId: a.teamMemberId,
          serviceVariationId: v.id,
          durationMinutes: v.durationMinutes,
        };
      }),
    });

    if (out.length >= limit) break;
  }

  return out;
}

/**
 * "Back-to-back" mode — every member uses the same barber, sequentially.
 * Member 1 starts at T, member 2 at T + d1, member 3 at T + d1 + d2, etc.
 *
 * A start T is valid when the chosen barber has a slot at T for member
 * 1's variation AND a slot at T + cumulative offset for each subsequent
 * member's variation. We don't need a separate "is barber free for an
 * arbitrary block" query because Square's bookable start times already
 * encode the barber's full schedule (lunch breaks, prior bookings, end
 * of day) — if a slot exists at T+offset for a service that lasts as
 * long as that service, that segment is feasible.
 */
export async function findGroupSlotsBackToBack(
  members: GroupMember[],
  teamMemberId: string,
  opts: FindOptions = {},
): Promise<BackToBackSlot[]> {
  if (members.length < 2) return [];

  // Resolve the specific variation each member should use given this
  // barber. For per-barber services Square has one variation per
  // barber, so this picks the right one. If any member has no
  // qualifying variation for the chosen barber, the group can't book
  // back-to-back with them — return [] so the wizard surfaces "no
  // openings" rather than fabricating an impossible slot.
  const resolved: ServiceVariation[] = [];
  for (const m of members) {
    const v = variationFor(m, teamMemberId);
    if (!v) return [];
    resolved.push(v);
  }

  const range: SearchRange = {
    startAt: opts.startAt ?? new Date(Date.now() + 60 * 60 * 1000),
    endAt: new Date(
      (opts.startAt ?? new Date()).getTime() + (opts.windowDays ?? 90) * DAY_MS,
    ),
  };

  // Fetch the barber's slot list per resolved variation. Same variation
  // across members results in a deduped fetch. Chunked so the search
  // window can run beyond Square's 31-day per-call cap.
  const variationIds = Array.from(new Set(resolved.map((v) => v.id)));
  const fetched = new Map<string, AvailabilitySlot[]>();
  await Promise.all(
    variationIds.map(async (vid) => {
      const slots = await searchVariationBarber(vid, teamMemberId, range);
      fetched.set(vid, slots);
    }),
  );

  const firstSlots = fetched.get(resolved[0].id) ?? [];
  const out: BackToBackSlot[] = [];
  const limit = Math.max(1, opts.limit ?? 200);

  // Pre-index each variation's slot times by parsed millisecond
  // timestamp keyed to the *original* Square-returned string. We
  // can't compare via `new Date(ms).toISOString()` against Square's
  // strings — Square emits without milliseconds (`2026-05-12T15:30:00Z`)
  // and toISOString always emits with (`...:00.000Z`). String equality
  // would fail even when the slot is actually bookable. Comparing on
  // ms-since-epoch sidesteps the format mismatch; storing the original
  // string lets us echo Square's exact wire format back in segments.
  const indexByVariation = new Map<string, Map<number, string>>();
  for (const [vid, slots] of fetched) {
    const m = new Map<number, string>();
    for (const s of slots) {
      const t = new Date(s.startAtUtc).getTime();
      if (Number.isFinite(t)) m.set(t, s.startAtUtc);
    }
    indexByVariation.set(vid, m);
  }

  for (const first of firstSlots) {
    let cursorMs = new Date(first.startAtUtc).getTime();
    cursorMs += resolved[0].durationMinutes * 60_000;
    const segments: BackToBackSlot['segments'] = [
      {
        memberKey: members[0].key,
        startAtUtc: first.startAtUtc,
        serviceVariationId: resolved[0].id,
        durationMinutes: resolved[0].durationMinutes,
      },
    ];

    let feasible = true;
    for (let i = 1; i < members.length; i++) {
      const v = resolved[i];
      const idx = indexByVariation.get(v.id);
      const matchedAt = idx?.get(cursorMs);
      if (!matchedAt) {
        feasible = false;
        break;
      }
      segments.push({
        memberKey: members[i].key,
        startAtUtc: matchedAt,
        serviceVariationId: v.id,
        durationMinutes: v.durationMinutes,
      });
      cursorMs += v.durationMinutes * 60_000;
    }
    if (!feasible) continue;

    out.push({
      mode: 'back-to-back',
      startAtUtc: first.startAtUtc,
      dateKey: first.dateKey,
      teamMemberId,
      segments,
    });

    if (out.length >= limit) break;
  }

  return out;
}

const SHOP_TZ = 'America/New_York';
const DATE_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function dateKeyFor(utcIso: string): string {
  return DATE_KEY_FMT.format(new Date(utcIso));
}
