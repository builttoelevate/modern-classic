// Group booking creation — takes a resolved group slot (one of the
// shapes returned by /api/square/group-availability) plus the parent
// customer info and creates N Square bookings tied to a single Customer
// record. Each booking's customer_note is decorated with a shared
// group identifier so the shop can scan the family at a glance in the
// Square dashboard.

import type { APIRoute } from 'astro';
import { SquareApiError } from '../../../lib/square/client';
import { findOrCreateCustomer, getCustomerById } from '../../../lib/square/customers';
import { createBooking } from '../../../lib/square/bookings';
import { getServices } from '../../../lib/square/catalog';
import { bookingIdempotencyKey } from '../../../lib/booking/idempotency';
import { redactEmail } from '../../../lib/booking/log';
import { getSession } from '../../../lib/auth/middleware';
import { randomBytes } from 'node:crypto';

export const prerender = false;

interface MemberAssignment {
  key: string;
  displayName: string;
  serviceVariationId: string;
  teamMemberId: string;
  durationMinutes: number;
  /** ISO UTC start time. For "all-at-once" all members share the same
   * value; for "back-to-back" each is offset by the prior durations. */
  startAtUtc: string;
}
interface RequestBody {
  mode: 'all-at-once' | 'back-to-back';
  assignments: MemberAssignment[];
  parent: {
    givenName: string;
    familyName: string;
    email: string;
    phone: string;
  };
  /** Optional free-text note from the parent ("youngest is nervous"). */
  groupNote?: string;
}

interface BookingFailure {
  memberKey: string;
  displayName: string;
  code: string;
  detail: string;
  slotTaken: boolean;
}

interface OkResponse {
  ok: true;
  groupId: string;
  /** Booking ids in the same order as the request's assignments. Null
   * entries are members whose Square booking failed; pair with the
   * `failures` array for the per-member reason. */
  bookings: Array<{ memberKey: string; bookingId: string | null }>;
  failures: BookingFailure[];
  customerId: string;
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

function logGroup(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[GROUP-BOOK] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function newGroupId(): string {
  return `mc-grp-${randomBytes(4).toString('hex')}`;
}

function classifySlotTaken(err: SquareApiError): boolean {
  const msg = `${err.code} ${err.detail}`.toLowerCase();
  return (
    err.status === 409 ||
    err.code === 'BOOKING_CONFLICT' ||
    err.code === 'TIME_CONFLICT' ||
    err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
    /already.*book|conflict|not available|overlap/.test(msg)
  );
}

function validate(body: unknown): RequestBody | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (b.mode !== 'all-at-once' && b.mode !== 'back-to-back') {
    return 'mode must be "all-at-once" or "back-to-back".';
  }
  if (!Array.isArray(b.assignments) || b.assignments.length < 2 || b.assignments.length > 4) {
    return 'assignments must contain 2–4 entries.';
  }
  const assignments: MemberAssignment[] = [];
  for (const a of b.assignments) {
    if (!a || typeof a !== 'object') return 'Each assignment must be an object.';
    const aa = a as Record<string, unknown>;
    if (typeof aa.key !== 'string' || !aa.key.trim()) return 'assignment.key required.';
    if (typeof aa.serviceVariationId !== 'string' || !aa.serviceVariationId.trim()) {
      return 'assignment.serviceVariationId required.';
    }
    if (typeof aa.teamMemberId !== 'string' || !aa.teamMemberId.trim()) {
      return 'assignment.teamMemberId required.';
    }
    if (typeof aa.durationMinutes !== 'number' || aa.durationMinutes <= 0) {
      return 'assignment.durationMinutes must be > 0.';
    }
    if (typeof aa.startAtUtc !== 'string' || Number.isNaN(Date.parse(aa.startAtUtc))) {
      return 'assignment.startAtUtc must be a valid ISO date.';
    }
    assignments.push({
      key: aa.key.trim(),
      displayName: typeof aa.displayName === 'string' ? aa.displayName.trim() : '',
      serviceVariationId: aa.serviceVariationId.trim(),
      teamMemberId: aa.teamMemberId.trim(),
      durationMinutes: Math.floor(aa.durationMinutes),
      startAtUtc: aa.startAtUtc,
    });
  }
  if (!b.parent || typeof b.parent !== 'object') return 'parent block required.';
  const p = b.parent as Record<string, unknown>;
  const parent = {
    givenName: typeof p.givenName === 'string' ? p.givenName.trim() : '',
    familyName: typeof p.familyName === 'string' ? p.familyName.trim() : '',
    email: typeof p.email === 'string' ? p.email.trim() : '',
    phone: typeof p.phone === 'string' ? p.phone.trim() : '',
  };
  if (!parent.givenName || !parent.familyName) {
    return 'parent.givenName and parent.familyName required.';
  }
  if (!parent.email || !/^\S+@\S+\.\S+$/.test(parent.email)) {
    return 'parent.email must be a valid email.';
  }
  if (parent.phone.replace(/\D/g, '').length < 10) {
    return 'parent.phone must be 10+ digits.';
  }
  const groupNote =
    typeof b.groupNote === 'string' && b.groupNote.trim().length > 0
      ? b.groupNote.trim().slice(0, 400)
      : undefined;
  return { mode: b.mode, assignments, parent, groupNote };
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

  const groupId = newGroupId();
  const session = getSession(request);

  // 1. Resolve the parent's Square Customer record. Same priority as
  //    single-booking flow: signed-in session beats typed email; guests
  //    fall through to find-or-create.
  let resolvedCustomerId: string;
  try {
    if (session) {
      const verified = await getCustomerById(session.customerId);
      if (verified) {
        resolvedCustomerId = verified.id;
      } else {
        const found = await findOrCreateCustomer({
          givenName: v.parent.givenName,
          familyName: v.parent.familyName,
          email: v.parent.email.toLowerCase(),
          phone: v.parent.phone,
        });
        resolvedCustomerId = found.customer.id;
      }
    } else {
      const found = await findOrCreateCustomer({
        givenName: v.parent.givenName,
        familyName: v.parent.familyName,
        email: v.parent.email.toLowerCase(),
        phone: v.parent.phone,
      });
      resolvedCustomerId = found.customer.id;
    }
  } catch (err) {
    if (err instanceof SquareApiError) {
      return fail('SQUARE_ERROR', `${err.code}: ${err.detail}`, 502);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail('INTERNAL', detail, 500);
  }

  // 2. Look up each variation's current `version` from the catalog.
  //    Square requires it on POST /v2/bookings.
  let services;
  try {
    services = await getServices();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail('SQUARE_ERROR', detail, 502);
  }
  const versionByVariation = new Map<string, number>();
  const nameByVariation = new Map<string, string>();
  for (const s of services) {
    for (const vv of s.variations) {
      versionByVariation.set(vv.id, vv.version);
      nameByVariation.set(vv.id, `${s.name} — ${vv.name}`);
    }
  }

  // 3. Sequentially create each booking. Idempotency keys are
  //    deterministic per-(parent email, slot, variation) so a
  //    double-submit doesn't duplicate; a Square 409 on a later member
  //    surfaces as a per-member failure rather than failing the whole
  //    request — partial success is still useful to the customer.
  const bookings: OkResponse['bookings'] = [];
  const failures: BookingFailure[] = [];
  const total = v.assignments.length;

  for (let i = 0; i < v.assignments.length; i++) {
    const a = v.assignments[i];
    const version = versionByVariation.get(a.serviceVariationId);
    if (typeof version !== 'number') {
      failures.push({
        memberKey: a.key,
        displayName: a.displayName,
        code: 'SERVICE_VARIATION_GONE',
        detail: 'That service is no longer in the Square catalog.',
        slotTaken: false,
      });
      bookings.push({ memberKey: a.key, bookingId: null });
      continue;
    }

    const note = buildGroupNote({
      groupId,
      mode: v.mode,
      idx: i + 1,
      total,
      displayName: a.displayName,
      variationLabel: nameByVariation.get(a.serviceVariationId) ?? '',
      groupNote: v.groupNote,
    });
    const idempotencyKey = `${groupId}-${i + 1}-${bookingIdempotencyKey({
      email: v.parent.email,
      startAtUtc: a.startAtUtc,
      serviceVariationId: a.serviceVariationId,
    })}`.slice(0, 191);

    try {
      const booking = await createBooking({
        startAtUtc: a.startAtUtc,
        customerId: resolvedCustomerId,
        serviceVariationId: a.serviceVariationId,
        serviceVariationVersion: version,
        teamMemberId: a.teamMemberId,
        durationMinutes: a.durationMinutes,
        customerNote: note,
        idempotencyKey,
      });
      bookings.push({ memberKey: a.key, bookingId: booking.id });
      logGroup({
        phase: 'member-booked',
        groupId,
        memberKey: a.key,
        bookingId: booking.id,
        startAtUtc: a.startAtUtc,
      });
    } catch (err) {
      const slotTaken = err instanceof SquareApiError && classifySlotTaken(err);
      const code = err instanceof SquareApiError ? err.code : 'INTERNAL';
      const detail =
        err instanceof SquareApiError
          ? err.detail || 'Square error'
          : err instanceof Error
            ? err.message
            : String(err);
      failures.push({
        memberKey: a.key,
        displayName: a.displayName,
        code,
        detail,
        slotTaken,
      });
      bookings.push({ memberKey: a.key, bookingId: null });
      logGroup({
        phase: 'member-failed',
        groupId,
        memberKey: a.key,
        startAtUtc: a.startAtUtc,
        code,
        detail,
        slotTaken,
      });
    }
  }

  logGroup({
    phase: 'group-done',
    groupId,
    customerId: resolvedCustomerId,
    email: redactEmail(v.parent.email),
    total,
    succeeded: bookings.filter((b) => b.bookingId !== null).length,
    failures: failures.length,
  });

  return Response.json({
    ok: true,
    groupId,
    bookings,
    failures,
    customerId: resolvedCustomerId,
  } satisfies OkResponse);
};

interface NoteInput {
  groupId: string;
  mode: 'all-at-once' | 'back-to-back';
  idx: number;
  total: number;
  displayName: string;
  variationLabel: string;
  groupNote?: string;
}

function buildGroupNote(n: NoteInput): string {
  // Format: "Group [mc-grp-a1b2c3d4] · 1/3 · Tommy · Men's Haircut · all-at-once"
  // Lets the shop scan the dashboard and instantly see which Square
  // appointments are tied to the same family.
  const parts: string[] = [
    `Group [${n.groupId}]`,
    `${n.idx}/${n.total}`,
  ];
  if (n.displayName) parts.push(n.displayName);
  if (n.variationLabel) parts.push(n.variationLabel);
  parts.push(n.mode === 'all-at-once' ? 'all-at-once' : 'back-to-back');
  let note = parts.join(' · ');
  if (n.groupNote) note += `\nNote: ${n.groupNote}`;
  // Square caps customer_note around 4096 chars; we're nowhere near.
  return note.slice(0, 800);
}
