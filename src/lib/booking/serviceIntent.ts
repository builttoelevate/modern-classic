// Service-intent helpers — small predicates that classify a Square
// Service into product-grain categories the UI cares about.
//
// Keeps the "is this a kids service?" check in one place so the
// /book Step 4 radio default, future kid-aware copy, recs surfacing,
// etc. all read from the same source. Built on top of the existing
// slugForService mapper in liveServices.ts (which is itself the
// name → slug bridge between raw Square service names and our
// curated marketing/content slugs), so there's no second source of
// truth and no hardcoded variation IDs.

import type { Service } from '../square/types';
import { slugForService } from '../catalog/liveServices';

/**
 * True when the given Square service is the Kids Haircut. Used to
 * default the /book Step 4 "Who is this appointment for?" radio to
 * "Someone else" — most parents booking a kids cut shouldn't have
 * to manually flip the gate.
 */
export function isKidsService(service: Service | null | undefined): boolean {
  if (!service) return false;
  return slugForService(service).slug === 'kids-haircut';
}

/**
 * True when the given Square service is the "first visit" / "new
 * customer" consultation. Matched by name pattern because the catalog
 * item id changes if the shop owner rebuilds the item in Square. Used
 * to (a) pin the card to the top of Step 1, (b) gate Step 1 so first-
 * time customers can only book this service, and (c) decide whether
 * a non-first-visit preselect from a URL param should be honored.
 */
export function isFirstVisitService(service: Service | null | undefined): boolean {
  if (!service) return false;
  const n = service.name.toLowerCase();
  return n.includes('new customer') || n.includes('first visit') || n.includes('first-time');
}
