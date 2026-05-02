// Phase 5 Part B — fetch + hydrate a customer's bookings.
//
// Square's GET /v2/bookings supports a customer_id filter. We hydrate
// each booking with the service name (from the catalog) and the barber
// display name (from team-members) so the UI doesn't have to do a second
// round of lookups.

import { squareFetch } from './client';
import { MODERN_CLASSIC_LOCATION_ID } from './locations';
import { getServices } from './catalog';
import { getBarbers } from './team';
import type {
  Barber,
  Booking,
  ListBookingsResponse,
  Service,
  ServiceVariation,
} from './types';

const SHOP_TZ = 'America/New_York';

const TERMINAL_STATUSES = new Set<Booking['status']>([
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_SELLER',
  'NO_SHOW',
  'DECLINED',
]);

export interface BookingDetail {
  id: string;
  version: number;
  startAtUtc: string;
  startAtLocal: string;
  serviceName: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  barberId: string;
  barberName: string;
  durationMinutes: number;
  priceDisplay: string;
  status: Booking['status'];
  customerNote?: string;
  /** When this booking belongs to a linked person (kid, partner, etc.)
   * rather than the signed-in customer themselves, the linked person's
   * display name. The /my-bookings UI uses this to tag the row "for X". */
  bookingFor?: string;
}

export interface CustomerBookings {
  upcoming: BookingDetail[];
  past: BookingDetail[];
}

interface VariationLookup {
  serviceName: string;
  variation: ServiceVariation;
}

function buildVariationIndex(services: Service[]): Map<string, VariationLookup> {
  const map = new Map<string, VariationLookup>();
  for (const s of services) {
    for (const v of s.variations) {
      map.set(v.id, { serviceName: s.name, variation: v });
    }
  }
  return map;
}

function buildBarberIndex(barbers: Barber[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of barbers) map.set(b.id, b.displayName);
  return map;
}

function formatLocal(utc: string): string {
  const date = new Date(utc);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return dtf.format(date);
}

function priceFor(variation: ServiceVariation | undefined): string {
  if (variation?.priceCents !== null && variation?.priceCents !== undefined) {
    return `$${(variation.priceCents / 100).toFixed(0)}`;
  }
  // Variable-price services (Haircut + Design, NEW CUSTOMERS) — display
  // a friendly fallback. SQUARE_REFERENCE.md notes the price is set in
  // person, so we don't try to invent a number.
  return 'Set at appointment';
}

function hydrate(
  booking: Booking,
  variationIndex: Map<string, VariationLookup>,
  barberIndex: Map<string, string>,
): BookingDetail | null {
  const segment = booking.appointment_segments?.[0];
  if (!segment) return null;
  const lookup = variationIndex.get(segment.service_variation_id);
  const serviceName = lookup?.serviceName ?? 'Service';
  const variation = lookup?.variation;
  const barberName =
    barberIndex.get(segment.team_member_id) ??
    (segment.team_member_id ? 'Barber' : 'First available');

  return {
    id: booking.id,
    version: booking.version,
    startAtUtc: booking.start_at,
    startAtLocal: formatLocal(booking.start_at),
    serviceName,
    serviceVariationId: segment.service_variation_id,
    serviceVariationVersion: segment.service_variation_version,
    barberId: segment.team_member_id,
    barberName,
    durationMinutes: segment.duration_minutes,
    priceDisplay: priceFor(variation),
    status: booking.status,
    customerNote: booking.customer_note,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Square caps GET /v2/bookings start_at range at 31 days. Walk in 30-day
// windows to fetch a wider history.
const WINDOW_DAYS = 30;
// 6 windows back + 2 windows forward = ~6 months past + ~2 months future.
// Plenty for the customer portal; keeps to ≤8 parallel API calls.
const PAST_WINDOWS = 6;
const FUTURE_WINDOWS = 2;

async function fetchBookingsWindow(
  customerId: string,
  startAtMinMs: number,
  startAtMaxMs: number,
): Promise<Booking[]> {
  const all: Booking[] = [];
  let cursor: string | undefined;
  do {
    const query: Record<string, string | number | undefined> = {
      location_id: MODERN_CLASSIC_LOCATION_ID,
      customer_id: customerId,
      limit: 100,
      start_at_min: new Date(startAtMinMs).toISOString(),
      start_at_max: new Date(startAtMaxMs).toISOString(),
      cursor,
    };
    const res = await squareFetch<ListBookingsResponse>('/v2/bookings', { query });
    all.push(...(res.bookings ?? []));
    cursor = res.cursor;
  } while (cursor);
  return all;
}

async function listAllBookingsForCustomer(customerId: string): Promise<Booking[]> {
  const nowMs = Date.now();
  const windows: Array<Promise<Booking[]>> = [];
  // Past windows: each WINDOW_DAYS chunk going back.
  for (let i = 0; i < PAST_WINDOWS; i++) {
    const max = nowMs - i * WINDOW_DAYS * DAY_MS;
    const min = max - WINDOW_DAYS * DAY_MS;
    windows.push(fetchBookingsWindow(customerId, min, max));
  }
  // Future windows.
  for (let i = 0; i < FUTURE_WINDOWS; i++) {
    const min = nowMs + i * WINDOW_DAYS * DAY_MS;
    const max = min + WINDOW_DAYS * DAY_MS;
    windows.push(fetchBookingsWindow(customerId, min, max));
  }

  const results = await Promise.all(windows);
  // Merge + dedupe (windows may overlap at boundaries).
  const byId = new Map<string, Booking>();
  for (const list of results) {
    for (const b of list) byId.set(b.id, b);
  }
  return Array.from(byId.values());
}

export async function getCustomerBookings(customerId: string): Promise<CustomerBookings> {
  const [bookings, services, barbers] = await Promise.all([
    listAllBookingsForCustomer(customerId),
    getServices(),
    getBarbers(),
  ]);
  const variationIndex = buildVariationIndex(services);
  const barberIndex = buildBarberIndex(barbers);

  const nowMs = Date.now();
  const upcoming: BookingDetail[] = [];
  const past: BookingDetail[] = [];

  for (const b of bookings) {
    const detail = hydrate(b, variationIndex, barberIndex);
    if (!detail) continue;
    const startMs = new Date(detail.startAtUtc).getTime();
    const isUpcoming = startMs >= nowMs && !TERMINAL_STATUSES.has(detail.status);
    if (isUpcoming) {
      upcoming.push(detail);
    } else {
      past.push(detail);
    }
  }

  upcoming.sort((a, b) => new Date(a.startAtUtc).getTime() - new Date(b.startAtUtc).getTime());
  past.sort((a, b) => new Date(b.startAtUtc).getTime() - new Date(a.startAtUtc).getTime());

  return { upcoming, past };
}
