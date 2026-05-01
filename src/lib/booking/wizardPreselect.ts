// Phase 6 Part E — single source of URL-param-to-wizard-state plumbing.
//
// Reads ?service=, ?barber=, and ?reschedule= from the current URL and
// returns a structured preselect object. BookingWizard uses this to
// hydrate its initial reducer state.

export interface WizardPreselect {
  serviceVariationId?: string;
  teamMemberId?: string;
  rescheduleBookingId?: string;
}

/** Server-friendly: parses an arbitrary URL string. */
export function preselectFromUrl(url: string | URL): WizardPreselect {
  let u: URL;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    return {};
  }
  const out: WizardPreselect = {};
  const service = u.searchParams.get('service');
  if (service && service.trim()) out.serviceVariationId = service.trim();
  const barber = u.searchParams.get('barber');
  if (barber && barber.trim()) out.teamMemberId = barber.trim();
  const reschedule = u.searchParams.get('reschedule');
  if (reschedule && reschedule.trim()) out.rescheduleBookingId = reschedule.trim();
  return out;
}

/** Client-friendly: parses window.location.search. Safe to call at SSR (returns {}). */
export function preselectFromBrowser(): WizardPreselect {
  if (typeof window === 'undefined') return {};
  return preselectFromUrl(window.location.href);
}
