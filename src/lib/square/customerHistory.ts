// "Has this Square customer ever booked here before?" — used by the
// new-customer card-capture flow to decide whether to require a card on
// file. We DO count cancelled / no-show bookings: the point is "have we
// ever transacted with this person", not "do they have an active future
// booking".
//
// Cheaper than getCustomerBookings() in lib/square/customerBookings.ts —
// that one fans out across 8 windows and hydrates with catalog/team data.
// Here we just need a yes/no, so one window covering the past year is
// enough; if the answer is "no", they're new to us within the window
// that matters for cancellation policy.

import { squareFetch } from './client';
import { MODERN_CLASSIC_LOCATION_ID } from './locations';
import type { ListBookingsResponse } from './types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Square's GET /v2/bookings caps start_at_min/max at 31 days. Walk a
// year of past windows + a small future window to also catch existing
// future bookings (e.g. someone booked yesterday for next month and is
// now booking a second appointment — they're not a new customer).
const WINDOW_DAYS = 30;
const PAST_WINDOWS = 12;
const FUTURE_WINDOWS = 2;

async function fetchAny(
  customerId: string,
  startAtMinMs: number,
  startAtMaxMs: number,
): Promise<boolean> {
  const query: Record<string, string | number | undefined> = {
    location_id: MODERN_CLASSIC_LOCATION_ID,
    customer_id: customerId,
    limit: 1,
    start_at_min: new Date(startAtMinMs).toISOString(),
    start_at_max: new Date(startAtMaxMs).toISOString(),
  };
  const res = await squareFetch<ListBookingsResponse>('/v2/bookings', { query });
  return (res.bookings ?? []).length > 0;
}

export async function hasAnyPriorBooking(customerId: string): Promise<boolean> {
  if (!customerId) return false;
  const nowMs = Date.now();
  const checks: Array<Promise<boolean>> = [];
  for (let i = 0; i < PAST_WINDOWS; i++) {
    const max = nowMs - i * WINDOW_DAYS * ONE_DAY_MS;
    const min = max - WINDOW_DAYS * ONE_DAY_MS;
    checks.push(fetchAny(customerId, min, max));
  }
  for (let i = 0; i < FUTURE_WINDOWS; i++) {
    const min = nowMs + i * WINDOW_DAYS * ONE_DAY_MS;
    const max = min + WINDOW_DAYS * ONE_DAY_MS;
    checks.push(fetchAny(customerId, min, max));
  }
  // Short-circuit: as soon as any window returns true we know the
  // customer is returning. Promise.any rejects only when every promise
  // rejects, so wrap rejections as `false` to keep the semantics clean.
  try {
    return await Promise.any(
      checks.map((p) => p.then((b) => (b ? true : Promise.reject(new Error('no-bookings'))))),
    );
  } catch {
    return false;
  }
}
