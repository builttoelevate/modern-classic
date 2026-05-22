// Group booking creation — takes a resolved group slot (one of the
// shapes returned by /api/square/group-availability) plus the parent
// customer info and creates N Square bookings tied to a single Customer
// record. Each booking's customer_note is decorated with a shared
// group identifier so the shop can scan the family at a glance in the
// Square dashboard.

import type { APIRoute } from 'astro';
import { SquareApiError } from '../../../lib/square/client';
import {
  createCustomer,
  findOrCreateCustomer,
  getCustomerById,
} from '../../../lib/square/customers';
import { composeSellerNote, createBooking } from '../../../lib/square/bookings';
import {
  CustomerBlockedError,
  assertPhoneNotBlocked,
  blockedBookingPublicResponse,
} from '../../../lib/customer/blockedCustomers';
import { getServices } from '../../../lib/square/catalog';
import { bookingIdempotencyKey } from '../../../lib/booking/idempotency';
import { redactEmail } from '../../../lib/booking/log';
import { getSession } from '../../../lib/auth/middleware';
import {
  linkPerson,
  listLinkedPeople,
  type LinkedPerson,
} from '../../../lib/customer/profileLinks';
import {
  recordGroupMembers,
  type GroupManifestMember,
} from '../../../lib/customer/groupManifest';
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
  /** Routing for this member's booking:
   *   - 'self'             → use the parent's Square customerId
   *   - 'existing'         → use existingCustomerId (must be one of the
   *                           parent's already-linked people)
   *   - 'new' (default)    → create a Square customer record for this
   *                           person + link them under the parent so
   *                           future group bookings can pick them
   *                           straight from the dropdown */
  who?: 'self' | 'existing' | 'new';
  existingCustomerId?: string;
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
  bookings: Array<{
    memberKey: string;
    bookingId: string | null;
    customerId: string;
  }>;
  failures: BookingFailure[];
  parentCustomerId: string;
  /** People we just created + linked under this parent on this
   * submission. The wizard can use this to confirm the new entries
   * appeared in the profile. */
  newlyLinked: LinkedPerson[];
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
    const whoRaw = typeof aa.who === 'string' ? aa.who : '';
    const who: 'self' | 'existing' | 'new' =
      whoRaw === 'self' || whoRaw === 'existing' ? whoRaw : 'new';
    const existingCustomerId =
      typeof aa.existingCustomerId === 'string' && aa.existingCustomerId.trim()
        ? aa.existingCustomerId.trim()
        : undefined;
    assignments.push({
      key: aa.key.trim(),
      displayName: typeof aa.displayName === 'string' ? aa.displayName.trim() : '',
      serviceVariationId: aa.serviceVariationId.trim(),
      teamMemberId: aa.teamMemberId.trim(),
      durationMinutes: Math.floor(aa.durationMinutes),
      startAtUtc: aa.startAtUtc,
      who,
      existingCustomerId,
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
  let parentCustomerId: string;
  let parentPhone: string;
  try {
    if (session) {
      const verified = await getCustomerById(session.customerId);
      if (verified) {
        parentCustomerId = verified.id;
        parentPhone = verified.phone_number?.trim() || v.parent.phone;
      } else {
        const found = await findOrCreateCustomer({
          givenName: v.parent.givenName,
          familyName: v.parent.familyName,
          email: v.parent.email.toLowerCase(),
          phone: v.parent.phone,
        });
        parentCustomerId = found.customer.id;
        parentPhone = v.parent.phone;
        // Group flow doesn't expose a marketing-consent toggle; the
        // promise resolves to a noop and we don't need to wait on it.
        // The remaining group work (per-member createBooking calls)
        // takes long enough that the background promise will finish
        // before the response is sent.
        void found.marketingDecisionPromise;
      }
    } else {
      const found = await findOrCreateCustomer({
        givenName: v.parent.givenName,
        familyName: v.parent.familyName,
        email: v.parent.email.toLowerCase(),
        phone: v.parent.phone,
      });
      parentCustomerId = found.customer.id;
      parentPhone = v.parent.phone;
      void found.marketingDecisionPromise;
    }
  } catch (err) {
    if (err instanceof SquareApiError) {
      return fail('SQUARE_ERROR', `${err.code}: ${err.detail}`, 502);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail('INTERNAL', detail, 500);
  }

  // Block-from-booking enforcement. We check the PARENT/contact phone
  // only — per spec, group members (kids, partners) are subjects of the
  // booking but not the contact point. The contact is the one we'd
  // refuse online. See src/lib/customer/blockedCustomers.ts.
  try {
    await assertPhoneNotBlocked(parentPhone, {
      bookingContext: 'group',
      phoneOriginal: v.parent.phone,
      customerName: `${v.parent.givenName} ${v.parent.familyName}`.trim(),
      customerEmail: v.parent.email,
      // No single serviceId / startAt for the whole group — use the
      // first assignment as a representative datapoint for the log.
      serviceId: v.assignments[0]?.serviceVariationId,
      barberId: v.assignments[0]?.teamMemberId,
      selectedStartAt: v.assignments[0]?.startAtUtc,
      ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
  } catch (err) {
    if (err instanceof CustomerBlockedError) {
      return blockedBookingPublicResponse();
    }
    throw err;
  }

  // 2. Resolve each member's own Square customerId.
  //
  //    - 'self'     → parent's customerId
  //    - 'existing' → must already be one of the parent's linked
  //                   people (KV check); use that customerId
  //    - 'new'      → create a Square customer record (kid's first
  //                   name + parent's surname + parent's phone, no
  //                   email) and link them under the parent so the
  //                   wizard can pick them next time. Skip linking
  //                   for guest checkouts (no parent profile to
  //                   link into).
  //
  //    Group bookings now spread across N customer records (one per
  //    member) instead of all stacking under the parent — that's why
  //    /my-bookings already shows them with "for Tommy" / "for Jake"
  //    labels and lets the parent cancel each one independently. The
  //    merge logic on /my-bookings was built for this exact shape
  //    (Phase 8 linked-people).
  let existingLinks: LinkedPerson[] = [];
  if (session) {
    try {
      existingLinks = await listLinkedPeople(parentCustomerId);
    } catch {
      // Swallow — KV failures shouldn't block bookings; we just won't
      // be able to validate existing IDs against the link list.
    }
  }
  const existingLinkIds = new Set(existingLinks.map((p) => p.customerId));

  const memberCustomerIds = new Map<string, string>();
  const newlyLinked: LinkedPerson[] = [];
  for (const a of v.assignments) {
    if (a.who === 'self') {
      memberCustomerIds.set(a.key, parentCustomerId);
      continue;
    }
    if (a.who === 'existing' && a.existingCustomerId) {
      // Defensive — confirm the id is actually linked to this parent.
      // Without this check a tampered request could book under any
      // customer the attacker knew the id of.
      if (!existingLinkIds.has(a.existingCustomerId)) {
        return fail(
          'BAD_LINK',
          'That linked person is not on your profile.',
          400,
        );
      }
      memberCustomerIds.set(a.key, a.existingCustomerId);
      continue;
    }
    // Default + 'new': create a Square customer + (if signed in) link.
    if (!a.displayName) {
      return fail(
        'BAD_REQUEST',
        'Each new member needs a display name.',
        400,
      );
    }
    // Don't fabricate a surname from the parent — group members may
    // be cousins, friends, anyone whose last name doesn't match the
    // parent's. Take what the customer typed verbatim: if they wrote
    // two words ("Tommy Smith"), split first / rest into given /
    // family. If just one word ("Tommy"), use as given and leave
    // family empty (Square allows that).
    const trimmed = a.displayName.trim();
    const firstSpace = trimmed.indexOf(' ');
    const givenName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const familyName = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
    try {
      const created = await createCustomer({
        givenName,
        familyName,
        email: '',
        phone: parentPhone,
      });
      memberCustomerIds.set(a.key, created.id);
      if (session) {
        try {
          const link: LinkedPerson = {
            customerId: created.id,
            // Show exactly what the parent typed — no parent surname
            // tacked on. The chip picker on the next group booking
            // will read back "Tommy" if they typed "Tommy", not
            // "Tommy {Parent's Last Name}".
            displayName: trimmed,
            relationship: undefined,
            linkedAt: new Date().toISOString(),
          };
          await linkPerson(parentCustomerId, link);
          newlyLinked.push(link);
        } catch (err) {
          // Square record exists already — log and continue. Worst
          // case the customer just doesn't show up in next time's
          // dropdown; their booking still went through.
          const detail = err instanceof Error ? err.message : String(err);
          logGroup({
            phase: 'kid-link-write-failed',
            groupId,
            memberKey: a.key,
            kidId: created.id,
            detail,
          });
        }
      }
    } catch (err) {
      if (err instanceof SquareApiError) {
        return fail(
          'SQUARE_ERROR',
          `Could not create record for ${a.displayName}: ${err.detail}`,
          502,
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      return fail('INTERNAL', detail, 500);
    }
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

  // 3. Sequentially create each booking under that member's resolved
  //    customer id. Idempotency keys mix groupId so a double-submit
  //    doesn't duplicate; a Square 409 on a later member surfaces as a
  //    per-member failure rather than failing the whole request —
  //    partial success is still useful to the customer.
  const bookings: OkResponse['bookings'] = [];
  const failures: BookingFailure[] = [];
  const total = v.assignments.length;
  // Manifest entries collected as each booking succeeds. Written to
  // Redis once after the loop so /my-bookings has an authoritative
  // list of group members regardless of whether linkPerson succeeded
  // above.
  const manifestMembers: GroupManifestMember[] = [];

  for (let i = 0; i < v.assignments.length; i++) {
    const a = v.assignments[i];
    const memberCustomerId = memberCustomerIds.get(a.key);
    if (!memberCustomerId) {
      failures.push({
        memberKey: a.key,
        displayName: a.displayName,
        code: 'NO_CUSTOMER',
        detail: "Couldn't resolve a customer record for this member.",
        slotTaken: false,
      });
      bookings.push({ memberKey: a.key, bookingId: null, customerId: '' });
      continue;
    }
    const version = versionByVariation.get(a.serviceVariationId);
    if (typeof version !== 'number') {
      failures.push({
        memberKey: a.key,
        displayName: a.displayName,
        code: 'SERVICE_VARIATION_GONE',
        detail: 'That service is no longer in the Square catalog.',
        slotTaken: false,
      });
      bookings.push({ memberKey: a.key, bookingId: null, customerId: memberCustomerId });
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
    // Idempotency key: scoped per-(member customerId, slot, variation)
    // so each member's booking has its own. Group prefix makes a
    // double-submit of the whole group safe end-to-end.
    const idempotencyKey = `${groupId}-${i + 1}-${bookingIdempotencyKey({
      email: `${memberCustomerId}@group.local`,
      startAtUtc: a.startAtUtc,
      serviceVariationId: a.serviceVariationId,
    })}`.slice(0, 191);

    try {
      const booking = await createBooking({
        startAtUtc: a.startAtUtc,
        customerId: memberCustomerId,
        serviceVariationId: a.serviceVariationId,
        serviceVariationVersion: version,
        teamMemberId: a.teamMemberId,
        durationMinutes: a.durationMinutes,
        customerNote: note,
        sellerNote: composeSellerNote(
          'Booked',
          v.parent.givenName,
          v.parent.familyName,
          `— group of ${total}`,
        ),
        idempotencyKey,
      });
      bookings.push({
        memberKey: a.key,
        bookingId: booking.id,
        customerId: memberCustomerId,
      });
      manifestMembers.push({
        bookingId: booking.id,
        customerId: memberCustomerId,
        displayName: a.displayName?.trim() ?? '',
        position: i + 1,
      });
      logGroup({
        phase: 'member-booked',
        groupId,
        memberKey: a.key,
        bookingId: booking.id,
        memberCustomerId,
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
      bookings.push({
        memberKey: a.key,
        bookingId: null,
        customerId: memberCustomerId,
      });
      logGroup({
        phase: 'member-failed',
        groupId,
        memberKey: a.key,
        memberCustomerId,
        startAtUtc: a.startAtUtc,
        code,
        detail,
        slotTaken,
      });
    }
  }

  // Persist the group manifest so a future read path (or future
  // recovery script) has an authoritative list of who's in this
  // group, independent of whether linkPerson succeeded above or
  // whether the relationship graph has drifted since. Manifest
  // write failures are non-fatal — they're logged, and the booking
  // response still carries the booking IDs.
  if (manifestMembers.length > 0) {
    try {
      await recordGroupMembers(groupId, manifestMembers);
    } catch (err) {
      logGroup({
        phase: 'group-manifest-write-failed',
        groupId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logGroup({
    phase: 'group-done',
    groupId,
    parentCustomerId,
    email: redactEmail(v.parent.email),
    total,
    succeeded: bookings.filter((b) => b.bookingId !== null).length,
    failures: failures.length,
    newlyLinked: newlyLinked.length,
  });

  return Response.json({
    ok: true,
    groupId,
    bookings,
    failures,
    parentCustomerId,
    newlyLinked,
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
