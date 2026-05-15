// Unit tests for canChargeNoShow. The pure gate is the safest place
// to test — chargeNoShowBooking() itself orchestrates Square and Redis
// calls, which we'd need to mock end-to-end; that's better covered by
// the manual E2E checklist on the preview deploy.

import { describe, expect, it } from 'vitest';
import { canChargeNoShow } from './noShowCharge';
import type { Booking } from '../square/types';
import type { BookingCardRecord } from './cardIndex';

function mkBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_test',
    version: 1,
    status: 'ACCEPTED',
    start_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    location_id: 'L_test',
    customer_id: 'cust_test',
    ...overrides,
  };
}

function mkRecord(overrides: Partial<BookingCardRecord> = {}): BookingCardRecord {
  return {
    bookingId: 'bk_test',
    squareCustomerId: 'cust_test',
    squareCardId: 'card_test',
    servicePriceCents: 4500,
    serviceName: 'Haircut',
    startAtUtc: new Date().toISOString(),
    chargeStatus: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as BookingCardRecord;
}

describe('canChargeNoShow', () => {
  it('returns true for past appointment with pending card', () => {
    expect(canChargeNoShow(mkBooking(), mkRecord())).toBe(true);
  });

  it('returns true for past appointment with previously-failed card (retry path)', () => {
    expect(canChargeNoShow(mkBooking(), mkRecord({ chargeStatus: 'failed' }))).toBe(true);
  });

  it('returns false when there is no card record', () => {
    expect(canChargeNoShow(mkBooking(), null)).toBe(false);
  });

  it('returns false when the appointment is in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(canChargeNoShow(mkBooking({ start_at: future }), mkRecord())).toBe(false);
  });

  it('returns false when the booking has no start_at', () => {
    expect(canChargeNoShow(mkBooking({ start_at: undefined as unknown as string }), mkRecord())).toBe(
      false,
    );
  });

  it('returns false when the card is already charged for a no-show', () => {
    expect(canChargeNoShow(mkBooking(), mkRecord({ chargeStatus: 'no-show' }))).toBe(false);
  });

  it('returns false when the card was already used for a late-cancel charge', () => {
    expect(canChargeNoShow(mkBooking(), mkRecord({ chargeStatus: 'late-cancel' }))).toBe(false);
  });
});
