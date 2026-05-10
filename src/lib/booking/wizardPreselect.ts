// Phase 6 Part E — single source of URL-param-to-wizard-state plumbing.
//
// Reads ?service=, ?barber=, and ?reschedule= from the current URL and
// returns a structured preselect object. BookingWizard uses this to
// hydrate its initial reducer state.

import type { GroupBookingPreset } from '../../components/booking/group/groupWizardState';

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

// ---------- Group booking preset (re-book whole group) ----------
//
// The "Book whole group again" button on /my-bookings encodes the
// original group's services + mode + barber into a URL-safe base64
// blob so /book/group can re-hydrate the wizard one step away from
// the time picker. We keep this in the same module as the single-flow
// preselect helpers so URL-param plumbing lives in one place.

/** URL-safe base64 of a JSON-encoded preset. Symmetric with
 *  decodeGroupPreset; both ends agree on the encoding so the wizard
 *  can decode either client- or server-side without a Buffer/atob
 *  fork. */
export function encodeGroupPreset(preset: GroupBookingPreset): string {
  const json = JSON.stringify(preset);
  // btoa works in both the browser and modern Node, and only handles
  // Latin-1 — service ids and ASCII names are fine; for any UTF-8
  // characters in displayName we encodeURIComponent first.
  const utf8Safe = encodeURIComponent(json);
  const b64 = typeof btoa === 'function'
    ? btoa(utf8Safe)
    : Buffer.from(utf8Safe, 'utf-8').toString('base64');
  // URL-safe variant: + → -, / → _, strip trailing = padding.
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeGroupPreset(raw: string): GroupBookingPreset | null {
  if (!raw) return null;
  try {
    // Restore standard base64 alphabet + padding.
    let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const utf8Safe = typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('utf-8');
    const json = decodeURIComponent(utf8Safe);
    const parsed = JSON.parse(json) as GroupBookingPreset;
    if (!isValidPreset(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isValidPreset(v: unknown): v is GroupBookingPreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<GroupBookingPreset>;
  if (p.mode !== 'all-at-once' && p.mode !== 'back-to-back') return false;
  if (!Array.isArray(p.members) || p.members.length < 2 || p.members.length > 4) return false;
  return p.members.every(
    (m) =>
      m &&
      typeof m === 'object' &&
      typeof m.serviceVariationId === 'string' &&
      m.serviceVariationId.length > 0 &&
      (m.displayName === undefined || typeof m.displayName === 'string'),
  );
}
