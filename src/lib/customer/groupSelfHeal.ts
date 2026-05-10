// When /my-bookings or its refresh endpoint sees a group booking
// (groupId set, groupTotal known) but is missing siblings — i.e.
// `groupTotal` exceeds the number of bookings already pulled in for
// that group — pull the missing rows in. Two recovery paths,
// preferred first:
//
//   1. Group manifest. Written by /api/square/group-bookings the
//      moment all member bookings exist, so we can deterministically
//      look up every booking id in the group and fetch them by id —
//      no scanning required.
//
//   2. Phone fallback. For groups created before manifests existed
//      (or the rare case where the manifest write failed), scan
//      every Square customer sharing the parent's phone (group
//      members are minted with the parent's phone so SMS reminders
//      land on the parent's device) and adopt any of their bookings
//      whose groupId already appears in the parent's view. The
//      "groupId already in view" guard is critical: it prevents an
//      unrelated phone-sharer from leaking their bookings into the
//      parent's portal.

import type { BookingDetail, CustomerBookings } from '../square/customerBookings';
import {
  classifyBooking,
  getBookingDetailsByIds,
  getCustomerBookings,
} from '../square/customerBookings';
import { findCustomersByPhone, getCustomerById } from '../square/customers';
import { getGroupManifest } from './groupManifest';

interface GroupGap {
  total: number;
  visibleIds: Set<string>;
}

function computeGaps(bookings: CustomerBookings): Map<string, GroupGap> {
  const gaps = new Map<string, GroupGap>();
  for (const b of [...bookings.upcoming, ...bookings.past]) {
    if (!b.groupId || !b.groupTotal) continue;
    let g = gaps.get(b.groupId);
    if (!g) {
      g = { total: b.groupTotal, visibleIds: new Set() };
      gaps.set(b.groupId, g);
    }
    g.visibleIds.add(b.id);
  }
  return gaps;
}

function pushIntoBookings(
  bookings: CustomerBookings,
  detail: BookingDetail,
  bookingFor: string | undefined,
): void {
  const decorated: BookingDetail = bookingFor
    ? { ...detail, bookingFor }
    : detail;
  if (classifyBooking(decorated) === 'upcoming') {
    bookings.upcoming.push(decorated);
  } else {
    bookings.past.push(decorated);
  }
}

export async function adoptMissingGroupSiblings(
  parentCustomerId: string,
  knownCustomerIds: Set<string>,
  bookings: CustomerBookings,
): Promise<number> {
  const gaps = computeGaps(bookings);
  const incompleteGroupIds = new Set(
    [...gaps.entries()].filter(([, g]) => g.visibleIds.size < g.total).map(([id]) => id),
  );
  if (incompleteGroupIds.size === 0) return 0;

  let adopted = 0;

  // ---- Phase 1: manifest lookup ----
  const groupsWithoutManifest = new Set<string>();
  const manifestFetches = await Promise.all(
    [...incompleteGroupIds].map((gid) =>
      getGroupManifest(gid)
        .then((m) => ({ gid, manifest: m }))
        .catch(() => ({ gid, manifest: null })),
    ),
  );
  const idsToFetch: string[] = [];
  // Maps booking id → { displayName, customerId } so we can apply the
  // right "for X" decoration once the bookings come back.
  const decorationByBookingId = new Map<string, { displayName: string; customerId: string }>();
  for (const { gid, manifest } of manifestFetches) {
    if (!manifest) {
      groupsWithoutManifest.add(gid);
      continue;
    }
    const visible = gaps.get(gid)!.visibleIds;
    for (const m of manifest.members) {
      if (visible.has(m.bookingId)) continue;
      idsToFetch.push(m.bookingId);
      decorationByBookingId.set(m.bookingId, {
        displayName: m.displayName,
        customerId: m.customerId,
      });
    }
  }
  if (idsToFetch.length > 0) {
    const details = await getBookingDetailsByIds(idsToFetch);
    for (const d of details) {
      const dec = decorationByBookingId.get(d.id);
      // Suppress "for X" tag when the manifest member IS the parent
      // (e.g. self + self group) — those are the parent's own bookings.
      const bookingFor =
        dec && dec.customerId !== parentCustomerId && dec.displayName
          ? dec.displayName
          : undefined;
      pushIntoBookings(bookings, d, bookingFor);
      gaps.get(d.groupId!)?.visibleIds.add(d.id);
      adopted++;
    }
  }

  // ---- Phase 2: phone fallback for legacy groups without manifests ----
  const stillIncomplete = new Set(
    [...groupsWithoutManifest].filter((gid) => {
      const g = gaps.get(gid)!;
      return g.visibleIds.size < g.total;
    }),
  );
  if (stillIncomplete.size === 0) return adopted;

  const parent = await getCustomerById(parentCustomerId);
  const phone = parent?.phone_number?.trim();
  if (!phone) return adopted;

  const phoneMatches = await findCustomersByPhone(phone);
  const candidates = phoneMatches.filter((c) => c.id && !knownCustomerIds.has(c.id));
  if (candidates.length === 0) return adopted;

  const candidateBookings = await Promise.all(
    candidates.map((c) =>
      getCustomerBookings(c.id)
        .then((cb) => ({ customer: c, bookings: cb }))
        .catch(() => ({ customer: c, bookings: { upcoming: [], past: [] } })),
    ),
  );

  for (const { customer, bookings: cb } of candidateBookings) {
    const displayName =
      `${customer.given_name ?? ''} ${customer.family_name ?? ''}`.trim() || 'Group member';
    for (const b of [...cb.upcoming, ...cb.past]) {
      if (!b.groupId || !stillIncomplete.has(b.groupId)) continue;
      const visible = gaps.get(b.groupId)!.visibleIds;
      if (visible.has(b.id)) continue;
      pushIntoBookings(bookings, b, displayName);
      visible.add(b.id);
      adopted++;
    }
  }
  return adopted;
}
