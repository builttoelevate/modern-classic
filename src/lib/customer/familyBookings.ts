// Family-aware bookings fetch + merge for /my-bookings.
//
// Two coexisting models:
//   1. Legacy parent → kid via listLinkedPeople (the original model;
//      one adult, N kids). Predates family accounts.
//   2. Family accounts (PR 1) — two-or-more adults share one
//      account, optionally with kids in family.members.
//
// When the session customer is in a family, we read EVERY family
// member's bookings PLUS each adult's legacy linked kids, dedupe by
// customerId, and tag each non-self row with the owner's display
// name so the UI can render "for Briar" / "for Brook" without a
// second lookup. When no family exists, the path collapses to the
// legacy listLinkedPeople flow so single-customer accounts are
// unchanged.

import { getCustomerBookings, type CustomerBookings } from '../square/customerBookings';
import { getCustomerById } from '../square/customers';
import { listLinkedPeople, type LinkedPerson } from './profileLinks';
import {
  getFamilyForCustomer,
  type FamilyMember,
  type FamilyRecord,
} from './familyAccount';

/**
 * Resolve every family member's display name from Square at render
 * time. Stored family.members[*].displayName is a snapshot taken at
 * accept (or create) time and goes stale the moment a member edits
 * their profile name. The card on /profile and the "for X" booking
 * tag in /my-bookings should both reflect the live name — without
 * this fan-out, Brook updating her first name to "Brook" still
 * showed her as "Briar Bone" (the name on her Square record at the
 * moment she accepted the invite).
 *
 * Returns a Map<customerId, liveName>. Per-member fetch failures
 * fall back to the stored snapshot so a transient Square hiccup
 * doesn't blank the card. Exported so /profile can reuse the same
 * resolution.
 */
export async function resolveLiveFamilyMemberNames(
  family: FamilyRecord,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const results = await Promise.all(
    family.members.map((m) =>
      getCustomerById(m.customerId)
        .then((c) => ({ member: m, customer: c }))
        .catch(() => ({ member: m, customer: null })),
    ),
  );
  for (const { member, customer } of results) {
    const live = customer
      ? `${customer.given_name ?? ''} ${customer.family_name ?? ''}`.trim()
      : '';
    out.set(member.customerId, live || member.displayName || 'Member');
  }
  return out;
}

export interface MergedBookingsResult {
  bookings: CustomerBookings;
  family: FamilyRecord | null;
  /** customerId → display name. Used by callers to tag rows whose
   *  customerId isn't the session's. The session's own bookings stay
   *  un-tagged. */
  displayNameByCustomerId: Map<string, string>;
  /** Every customerId whose bookings contribute to this view. Used
   *  by the phone-based group-sibling self-heal to know which records
   *  it shouldn't re-adopt. */
  knownCustomerIds: Set<string>;
}

interface FetchTarget {
  customerId: string;
  displayName: string;
  /** When true, this is the session's own record — bookings keep
   *  `bookingFor` undefined so the UI doesn't tag them. */
  isSelf: boolean;
}

function emptyBookings(): CustomerBookings {
  return { upcoming: [], past: [] };
}

/**
 * Build the deduped list of customer records whose bookings we need
 * to fetch + merge for the session.
 *
 * When a family exists:
 *  - every family member (adult or kid) contributes their bookings
 *  - every adult also contributes their legacy linked kids
 *  - dedupe by customerId so a kid that's both in family.members AND
 *    in an adult's legacy linkedPeople doesn't get fetched twice
 *
 * When no family exists:
 *  - the session customer
 *  - their legacy listLinkedPeople
 */
async function resolveFetchTargets(
  sessionCustomerId: string,
  family: FamilyRecord | null,
): Promise<FetchTarget[]> {
  const byId = new Map<string, FetchTarget>();

  function add(id: string, displayName: string, isSelf: boolean): void {
    if (!id) return;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { customerId: id, displayName, isSelf });
      return;
    }
    // If this customer is the session, keep the self flag set even if
    // they show up again via the family or legacy paths.
    if (isSelf) existing.isSelf = true;
  }

  if (family) {
    // Every family member: adults + family-native kids.
    for (const m of family.members) {
      add(m.customerId, m.displayName, m.customerId === sessionCustomerId);
    }
    // Each adult's legacy linked kids — fan-out parallel, fall back
    // to empty on any per-adult failure so one bad KV read doesn't
    // blank everyone's view.
    const adults: FamilyMember[] = family.members.filter((m) => m.role === 'adult');
    const legacyKidLists = await Promise.all(
      adults.map((a) =>
        listLinkedPeople(a.customerId).catch(() => [] as LinkedPerson[]),
      ),
    );
    for (const kids of legacyKidLists) {
      for (const kid of kids) {
        add(kid.customerId, kid.displayName, false);
      }
    }
  } else {
    // Legacy path — session customer + their linked kids.
    add(sessionCustomerId, 'You', true);
    const legacy = await listLinkedPeople(sessionCustomerId).catch(
      () => [] as LinkedPerson[],
    );
    for (const kid of legacy) {
      add(kid.customerId, kid.displayName, false);
    }
  }

  return [...byId.values()];
}

/**
 * Fetch + merge bookings for the session customer's full view.
 * Single entry point used by both /my-bookings.astro (page render)
 * and /api/square/customer/bookings (refresh endpoint) so the two
 * never drift in logic.
 */
export async function getMergedBookingsForSession(
  sessionCustomerId: string,
): Promise<MergedBookingsResult> {
  const family = await getFamilyForCustomer(sessionCustomerId).catch(
    () => null,
  );
  const targets = await resolveFetchTargets(sessionCustomerId, family);

  // Refresh each family member's displayName from Square so a profile
  // rename ("Briar Bone" → "Brook Chicha") propagates to the
  // bookingFor tag without waiting for the stored snapshot to be
  // overwritten. No-op when there's no family.
  if (family) {
    const liveNames = await resolveLiveFamilyMemberNames(family).catch(
      () => new Map<string, string>(),
    );
    for (const t of targets) {
      const live = liveNames.get(t.customerId);
      if (live) t.displayName = live;
    }
  }

  // Parallel fetch with per-target degradation. One bad customer fetch
  // (deleted record, transient Square hiccup) shouldn't blank the rest.
  const fetched = await Promise.all(
    targets.map((t) =>
      getCustomerBookings(t.customerId)
        .then((b) => ({ target: t, bookings: b }))
        .catch(() => ({ target: t, bookings: emptyBookings() })),
    ),
  );

  const merged: CustomerBookings = emptyBookings();
  const displayNameByCustomerId = new Map<string, string>();
  const knownCustomerIds = new Set<string>();

  for (const { target, bookings } of fetched) {
    knownCustomerIds.add(target.customerId);
    if (!target.isSelf) {
      displayNameByCustomerId.set(target.customerId, target.displayName);
    }
    const tag = target.isSelf ? undefined : target.displayName;
    for (const b of bookings.upcoming) {
      merged.upcoming.push(tag ? { ...b, bookingFor: tag } : b);
    }
    for (const b of bookings.past) {
      merged.past.push(tag ? { ...b, bookingFor: tag } : b);
    }
  }

  merged.upcoming.sort(
    (a, b) => new Date(a.startAtUtc).getTime() - new Date(b.startAtUtc).getTime(),
  );
  merged.past.sort(
    (a, b) => new Date(b.startAtUtc).getTime() - new Date(a.startAtUtc).getTime(),
  );

  return {
    bookings: merged,
    family,
    displayNameByCustomerId,
    knownCustomerIds,
  };
}
