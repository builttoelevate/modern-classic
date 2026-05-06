// Group booking availability endpoint. The wizard POSTs the group
// composition (members, scheduling mode, optional fixed barber) and
// receives back the list of valid slots — each slot already encoded
// with the per-member assignment, so the wizard can render and submit
// it without re-running availability math.

import type { APIRoute } from 'astro';
import {
  findGroupSlotsAllAtOnce,
  findGroupSlotsBackToBack,
  type GroupMember,
  type GroupSlot,
} from '../../../lib/booking/groupAvailability';
import { getServices } from '../../../lib/square/catalog';
import { getBarbers } from '../../../lib/square/team';
import { SquareApiError } from '../../../lib/square/client';
import type { Service, Barber } from '../../../lib/square/types';

export const prerender = false;

interface MemberRequest {
  key: string;
  displayName: string;
  serviceVariationId: string;
}
interface RequestBody {
  mode: 'all-at-once' | 'back-to-back';
  members: MemberRequest[];
  /** Required when mode === 'back-to-back'. */
  teamMemberId?: string;
  /** Optional ISO bound; defaults to now. */
  startAt?: string;
  windowDays?: number;
}
interface OkResponse {
  ok: true;
  slots: GroupSlot[];
}
interface FailResponse {
  ok: false;
  error: { code: string; detail: string };
}

function fail(code: string, detail: string, status: number): Response {
  return Response.json(
    { ok: false, error: { code, detail } } satisfies FailResponse,
    { status },
  );
}

function validate(body: unknown): RequestBody | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object.';
  const b = body as Record<string, unknown>;
  const mode = b.mode;
  if (mode !== 'all-at-once' && mode !== 'back-to-back') {
    return 'mode must be "all-at-once" or "back-to-back".';
  }
  if (!Array.isArray(b.members) || b.members.length < 2 || b.members.length > 4) {
    return 'members must be an array of 2–4 entries.';
  }
  const members: MemberRequest[] = [];
  for (const m of b.members) {
    if (!m || typeof m !== 'object') return 'Each member must be an object.';
    const mm = m as Record<string, unknown>;
    if (typeof mm.key !== 'string' || !mm.key.trim()) return 'member.key required.';
    if (typeof mm.serviceVariationId !== 'string' || !mm.serviceVariationId.trim()) {
      return 'member.serviceVariationId required.';
    }
    const displayName = typeof mm.displayName === 'string' ? mm.displayName.trim() : '';
    members.push({
      key: mm.key.trim(),
      displayName,
      serviceVariationId: mm.serviceVariationId.trim(),
    });
  }
  if (mode === 'back-to-back') {
    if (typeof b.teamMemberId !== 'string' || !b.teamMemberId.trim()) {
      return 'teamMemberId required for back-to-back mode.';
    }
  }
  const startAt = typeof b.startAt === 'string' ? b.startAt : undefined;
  const windowDays =
    typeof b.windowDays === 'number' && Number.isFinite(b.windowDays)
      ? b.windowDays
      : undefined;
  return {
    mode,
    members,
    teamMemberId: typeof b.teamMemberId === 'string' ? b.teamMemberId.trim() : undefined,
    startAt,
    windowDays,
  };
}

export const POST: APIRoute = async ({ request }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('BAD_REQUEST', 'Body must be valid JSON.', 400);
  }
  const v = validate(raw);
  if (typeof v === 'string') return fail('BAD_REQUEST', v, 400);

  // Resolve each requested serviceVariationId against the catalog so we
  // can attach durationMinutes and the eligible barber roster. The
  // group matcher needs both.
  let services: Service[];
  let barbers: Barber[];
  try {
    [services, barbers] = await Promise.all([getServices(), getBarbers()]);
  } catch (err) {
    if (err instanceof SquareApiError) {
      return fail('SQUARE_ERROR', `${err.code}: ${err.detail}`, 502);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail('INTERNAL', detail, 500);
  }
  const activeBarberIds = new Set(barbers.map((b) => b.id));
  const variationLookup = new Map<string, ReturnType<typeof toMember> | null>();
  function toMember(svid: string): ReturnType<typeof buildLookup> | null {
    return buildLookup(svid);
  }
  function buildLookup(svid: string) {
    for (const s of services) {
      const variation = s.variations.find((vv) => vv.id === svid);
      if (!variation) continue;
      const eligible = variation.eligibleTeamMemberIds.filter((id) =>
        activeBarberIds.has(id),
      );
      if (eligible.length === 0) return null;
      return { variation, eligibleBarberIds: eligible };
    }
    return null;
  }

  const groupMembers: GroupMember[] = [];
  for (const m of v.members) {
    let resolved = variationLookup.get(m.serviceVariationId);
    if (resolved === undefined) {
      resolved = toMember(m.serviceVariationId);
      variationLookup.set(m.serviceVariationId, resolved);
    }
    if (!resolved) {
      return fail(
        'BAD_VARIATION',
        `Service variation ${m.serviceVariationId} is no longer bookable.`,
        422,
      );
    }
    groupMembers.push({
      key: m.key,
      displayName: m.displayName,
      variation: resolved.variation,
      eligibleBarberIds: resolved.eligibleBarberIds,
    });
  }

  const startAt = v.startAt ? new Date(v.startAt) : undefined;
  if (startAt && Number.isNaN(startAt.getTime())) {
    return fail('BAD_REQUEST', 'startAt is not a valid ISO date.', 400);
  }

  try {
    let slots: GroupSlot[];
    if (v.mode === 'all-at-once') {
      slots = await findGroupSlotsAllAtOnce(groupMembers, {
        startAt,
        windowDays: v.windowDays,
      });
    } else {
      // Restrict each member's eligibleBarberIds to the chosen barber
      // so the matcher only considers slots that barber can cover.
      const teamMemberId = v.teamMemberId!;
      for (const m of groupMembers) {
        if (!m.eligibleBarberIds.includes(teamMemberId)) {
          return fail(
            'BARBER_UNQUALIFIED',
            `Selected barber can't perform ${m.variation.name}.`,
            422,
          );
        }
      }
      slots = await findGroupSlotsBackToBack(groupMembers, teamMemberId, {
        startAt,
        windowDays: v.windowDays,
      });
    }
    return Response.json({ ok: true, slots } satisfies OkResponse);
  } catch (err) {
    if (err instanceof SquareApiError) {
      return fail('SQUARE_ERROR', `${err.code}: ${err.detail}`, 502);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail('INTERNAL', detail, 500);
  }
};
