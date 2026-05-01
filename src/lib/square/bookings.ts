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
  idempotencyKey: string;
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const body = {
    idempotency_key: input.idempotencyKey,
    booking: {
      start_at: input.startAtUtc,
      location_id: MODERN_CLASSIC_LOCATION_ID,
      customer_id: input.customerId,
      ...(input.customerNote ? { customer_note: input.customerNote } : {}),
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
