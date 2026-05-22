import { squareFetch } from './client';
import { MODERN_CLASSIC_LOCATION_ID } from './locations';
import type { Booking, CreateBookingResponse, ListBookingsResponse } from './types';

export interface CreateBookingInput {
  startAtUtc: string;
  customerId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  teamMemberId: string;
  durationMinutes: number;
  customerNote?: string;
  /** Free-text label visible to the seller in Square's dashboard but NOT
   *  to the customer. Stamp every API-created booking so Michael can
   *  tell customer self-bookings apart from his own manual entries.
   *  Square's `creator_details` is read-only and locks every API booking
   *  to creator_type=TEAM_MEMBER (= "booked by Michael"), so seller_note
   *  is the realistic workaround. Use composeSellerNote() to build the
   *  string consistently. */
  sellerNote?: string;
  idempotencyKey: string;
}

/**
 * Defensive composer for the seller-visible `seller_note` field. Never
 * throws — booking creation must never fail because the seller_note
 * couldn't be built. Falls back to a generic "via website" label when
 * the name fields are empty.
 *
 *   composeSellerNote('Booked', 'Bill', 'Chicha')
 *     → "Booked online by Bill Chicha"
 *   composeSellerNote('Booked', 'Bill', '', 'for Brook')
 *     → "Booked online by Bill for Brook"
 *   composeSellerNote('Rescheduled', '', '')
 *     → "Rescheduled online via website"
 */
export function composeSellerNote(
  action: 'Booked' | 'Rescheduled',
  given: string | undefined | null,
  family: string | undefined | null,
  suffix?: string,
): string {
  const name = [given, family]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(' ');
  if (!name) return `${action} online via website`;
  const trimmedSuffix = (suffix ?? '').trim();
  return trimmedSuffix
    ? `${action} online by ${name} ${trimmedSuffix}`
    : `${action} online by ${name}`;
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const body = {
    idempotency_key: input.idempotencyKey,
    booking: {
      start_at: input.startAtUtc,
      location_id: MODERN_CLASSIC_LOCATION_ID,
      customer_id: input.customerId,
      ...(input.customerNote ? { customer_note: input.customerNote } : {}),
      ...(input.sellerNote ? { seller_note: input.sellerNote } : {}),
      appointment_segments: [
        {
          duration_minutes: input.durationMinutes,
          service_variation_id: input.serviceVariationId,
          service_variation_version: input.serviceVariationVersion,
          team_member_id: input.teamMemberId,
        },
      ],
    },
  };

  const res = await squareFetch<CreateBookingResponse>('/v2/bookings', {
    method: 'POST',
    body,
  });
  if (!res.booking) throw new Error('Square /v2/bookings POST returned no booking');
  return res.booking;
}

export interface ListBookingsParams {
  limit?: number;
  cursor?: string;
  startAtMin?: string;
  startAtMax?: string;
}

export async function listBookings(params: ListBookingsParams = {}): Promise<{
  bookings: Booking[];
  cursor?: string;
}> {
  const query: Record<string, string | number | undefined> = {
    location_id: MODERN_CLASSIC_LOCATION_ID,
    limit: params.limit ?? 50,
    cursor: params.cursor,
    start_at_min: params.startAtMin,
    start_at_max: params.startAtMax,
  };
  const res = await squareFetch<ListBookingsResponse>('/v2/bookings', { query });
  return { bookings: res.bookings ?? [], cursor: res.cursor };
}

export async function getBooking(id: string): Promise<Booking> {
  const res = await squareFetch<CreateBookingResponse>(`/v2/bookings/${id}`);
  if (!res.booking) throw new Error(`Booking ${id} not found`);
  return res.booking;
}

export interface CancelBookingInput {
  bookingId: string;
  bookingVersion: number;
  idempotencyKey: string;
}

export async function cancelBooking(input: CancelBookingInput): Promise<Booking> {
  const res = await squareFetch<CreateBookingResponse>(
    `/v2/bookings/${input.bookingId}/cancel`,
    {
      method: 'POST',
      body: {
        booking_version: input.bookingVersion,
        idempotency_key: input.idempotencyKey,
      },
    },
  );
  if (!res.booking) throw new Error(`Square cancel /v2/bookings/${input.bookingId}/cancel returned no booking`);
  return res.booking;
}
