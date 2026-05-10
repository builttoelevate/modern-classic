// When /my-bookings or its refresh endpoint sees a group booking
// (groupId set, groupTotal known) but is missing siblings — i.e.
// `groupTotal` exceeds the number of bookings already pulled in for
// that group — it means the missing members live under separate
// Square customer records that aren't in the parent's linked-people
// list. This usually happens because /api/square/group-bookings
// failed to write the linkPerson record at booking creation time
// (the failure is logged but swallowed so the booking still goes
// through). Without a manifest of who's in the group, the only
// breadcrumb left is the phone number — group members are minted
// with the parent's phone so SMS reminders go to the parent's
// device.
//
// This helper does the recovery: scan customers who share the
// parent's phone, fetch their bookings, and adopt any whose
// groupId already appears in the parent's view. The "groupId
// already in view" guard is critical — it prevents an unrelated
// phone-sharer (e.g. the duplicate-account case the surrounding
// commits also fix) from leaking their bookings into the parent's
// portal. We never adopt a booking whose group we don't already
// recognize.

import type { CustomerBookings } from '../square/customerBookings';
import { getCustomerBookings } from '../square/customerBookings';
import { findCustomersByPhone, getCustomerById } from '../square/customers';

export async function adoptMissingGroupSiblings(
  parentCustomerId: string,
  knownCustomerIds: Set<string>,
  bookings: CustomerBookings,
): Promise<number> {
  const groupGaps = new Map<string, { total: number; visibleIds: Set<string> }>();
  for (const b of [...bookings.upcoming, ...bookings.past]) {
    if (!b.groupId || !b.groupTotal) continue;
    let g = groupGaps.get(b.groupId);
    if (!g) {
      g = { total: b.groupTotal, visibleIds: new Set() };
      groupGaps.set(b.groupId, g);
    }
    g.visibleIds.add(b.id);
  }
  const incompleteGroupIds = new Set(
    [...groupGaps.entries()].filter(([, g]) => g.visibleIds.size < g.total).map(([id]) => id),
  );
  if (incompleteGroupIds.size === 0) return 0;

  const parent = await getCustomerById(parentCustomerId);
  const phone = parent?.phone_number?.trim();
  if (!phone) return 0;

  const phoneMatches = await findCustomersByPhone(phone);
  const candidates = phoneMatches.filter((c) => c.id && !knownCustomerIds.has(c.id));
  if (candidates.length === 0) return 0;

  const candidateBookings = await Promise.all(
    candidates.map((c) =>
      getCustomerBookings(c.id)
        .then((cb) => ({ customer: c, bookings: cb }))
        .catch(() => ({ customer: c, bookings: { upcoming: [], past: [] } })),
    ),
  );

  let adopted = 0;
  for (const { customer, bookings: cb } of candidateBookings) {
    const displayName =
      `${customer.given_name ?? ''} ${customer.family_name ?? ''}`.trim() || 'Group member';
    for (const b of cb.upcoming) {
      if (
        b.groupId &&
        incompleteGroupIds.has(b.groupId) &&
        !groupGaps.get(b.groupId)!.visibleIds.has(b.id)
      ) {
        bookings.upcoming.push({ ...b, bookingFor: displayName });
        groupGaps.get(b.groupId)!.visibleIds.add(b.id);
        adopted++;
      }
    }
    for (const b of cb.past) {
      if (
        b.groupId &&
        incompleteGroupIds.has(b.groupId) &&
        !groupGaps.get(b.groupId)!.visibleIds.has(b.id)
      ) {
        bookings.past.push({ ...b, bookingFor: displayName });
        groupGaps.get(b.groupId)!.visibleIds.add(b.id);
        adopted++;
      }
    }
  }
  return adopted;
}
