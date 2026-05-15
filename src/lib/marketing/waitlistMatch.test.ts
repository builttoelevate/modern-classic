// Unit tests for the pure waitlist matcher. Covers the new
// `exactTimes` + `exactTimesMatchMode` paths AND the existing
// `timesOfDay` band behavior so the refactor doesn't regress.
//
// No I/O: all inputs are constructed in-memory. The matcher uses
// Intl.DateTimeFormat in 'America/New_York' to bin slot hours, so
// slots are constructed in UTC such that the shop-local hour is
// deterministic regardless of when the test runs.

import { describe, expect, it } from 'vitest';
import { findMatchingSlot } from './waitlistMatch';
import type { AvailabilitySlot } from '../square/types';
import type { WaitlistEntry } from './waitlistLog';

// EST is UTC-5; EDT is UTC-4. We're running these tests against a
// fixed mid-summer date so DST is in effect (EDT, UTC-4). That makes
// 15:00 EDT == 19:00 UTC. The matcher relies on Intl, not on naive
// arithmetic, so this stays robust through DST transitions in
// production — the fixture just has to express the intent clearly.
const TEST_DATE = '2026-07-15'; // Wednesday in shop tz

function slot(hourMinute: string): AvailabilitySlot {
  const [h, m] = hourMinute.split(':').map(Number);
  // 15:00 local EDT → 19:00 UTC
  const utcHour = h + 4;
  const iso = `2026-07-15T${String(utcHour).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
  return {
    startAtUtc: iso,
    dateKey: TEST_DATE,
  } as AvailabilitySlot;
}

function baseEntry(over: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    id: 'wl_test',
    customerName: 'Test Person',
    customerEmail: 'test@example.com',
    customerPhone: '+17405551234',
    serviceName: 'Haircut',
    barberName: 'Michael',
    serviceVariationId: 'svc_x',
    teamMemberId: 'tm_y',
    submittedAt: '2026-07-01T12:00:00Z',
    status: 'new',
    ...over,
  };
}

describe('findMatchingSlot — exact times (loose, default)', () => {
  it('matches a slot at the exact requested time', () => {
    const entry = baseEntry({ exactTimes: ['15:00'] });
    expect(findMatchingSlot(entry, [slot('15:00')])).not.toBeNull();
  });

  it('matches slots within ±30 minutes (loose default)', () => {
    const entry = baseEntry({ exactTimes: ['15:00'] });
    for (const t of ['14:30', '14:45', '15:15', '15:30']) {
      expect(findMatchingSlot(entry, [slot(t)])).not.toBeNull();
    }
  });

  it('rejects slots outside the ±30 minute window', () => {
    const entry = baseEntry({ exactTimes: ['15:00'] });
    expect(findMatchingSlot(entry, [slot('14:29')])).toBeNull();
    expect(findMatchingSlot(entry, [slot('15:31')])).toBeNull();
  });

  it('treats explicit loose mode the same as default', () => {
    const entry = baseEntry({ exactTimes: ['15:00'], exactTimesMatchMode: 'loose' });
    expect(findMatchingSlot(entry, [slot('14:45')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('15:30')])).not.toBeNull();
  });

  it('matches any of multiple exact times (union)', () => {
    const entry = baseEntry({ exactTimes: ['09:00', '17:00'] });
    expect(findMatchingSlot(entry, [slot('09:15')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('16:45')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('13:00')])).toBeNull();
  });

  it('returns the earliest matching slot when several are eligible', () => {
    const entry = baseEntry({ exactTimes: ['15:00'] });
    const match = findMatchingSlot(entry, [slot('15:30'), slot('14:30'), slot('15:00')]);
    expect(match?.startAtUtc).toContain('T18:30:00'); // 14:30 EDT
  });
});

describe('findMatchingSlot — exact times (strict)', () => {
  it('matches only the exact minute when mode is "exact"', () => {
    const entry = baseEntry({ exactTimes: ['15:00'], exactTimesMatchMode: 'exact' });
    expect(findMatchingSlot(entry, [slot('15:00')])).not.toBeNull();
  });

  it('rejects ±1 minute when mode is "exact"', () => {
    const entry = baseEntry({ exactTimes: ['15:00'], exactTimesMatchMode: 'exact' });
    for (const t of ['14:45', '14:55', '15:05', '15:15']) {
      expect(findMatchingSlot(entry, [slot(t)])).toBeNull();
    }
  });

  it('matches only the listed times with strict mode + multiple times', () => {
    const entry = baseEntry({
      exactTimes: ['09:00', '17:00'],
      exactTimesMatchMode: 'exact',
    });
    expect(findMatchingSlot(entry, [slot('09:00')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('17:00')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('09:15')])).toBeNull();
    expect(findMatchingSlot(entry, [slot('16:55')])).toBeNull();
  });
});

describe('findMatchingSlot — bands (regression for existing behavior)', () => {
  it('matches a morning slot for a morning-only entry', () => {
    const entry = baseEntry({ timesOfDay: ['morning'] });
    expect(findMatchingSlot(entry, [slot('10:00')])).not.toBeNull();
  });

  it('rejects an evening slot for a morning-only entry', () => {
    const entry = baseEntry({ timesOfDay: ['morning'] });
    expect(findMatchingSlot(entry, [slot('16:00')])).toBeNull();
  });

  it('union of multiple bands', () => {
    const entry = baseEntry({ timesOfDay: ['morning', 'evening'] });
    expect(findMatchingSlot(entry, [slot('10:00')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('17:00')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('13:00')])).toBeNull();
  });
});

describe('findMatchingSlot — edge cases', () => {
  it('empty exactTimes array treats entry as having no time preference', () => {
    const entry = baseEntry({ exactTimes: [] });
    // No time pref → any time matches.
    expect(findMatchingSlot(entry, [slot('07:00')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('22:00')])).not.toBeNull();
  });

  it('exactTimes wins when both fields are present (defensive)', () => {
    // API enforces mutual exclusion, but matcher must not match the
    // band when exactTimes is non-empty.
    const entry = baseEntry({
      exactTimes: ['15:00'],
      timesOfDay: ['morning'],
    });
    expect(findMatchingSlot(entry, [slot('15:00')])).not.toBeNull();
    expect(findMatchingSlot(entry, [slot('10:00')])).toBeNull();
  });

  it('garbage HH:MM entries are ignored, valid ones still match', () => {
    const entry = baseEntry({ exactTimes: ['abc', '25:99', '15:00'] });
    expect(findMatchingSlot(entry, [slot('15:00')])).not.toBeNull();
  });

  it('all-garbage exactTimes never matches', () => {
    const entry = baseEntry({ exactTimes: ['abc', '99:99'] });
    expect(findMatchingSlot(entry, [slot('15:00')])).toBeNull();
  });

  it('honors day-of-week filter alongside exactTimes', () => {
    // 2026-07-15 is a Wednesday in shop tz.
    const entry = baseEntry({
      exactTimes: ['15:00'],
      daysOfWeek: ['mon', 'tue'],  // Wednesday excluded
    });
    expect(findMatchingSlot(entry, [slot('15:00')])).toBeNull();
  });

  it('honors date window filter alongside exactTimes', () => {
    const entry = baseEntry({
      exactTimes: ['15:00'],
      dateFrom: '2026-07-20',
      dateTo: '2026-07-25',
    });
    expect(findMatchingSlot(entry, [slot('15:00')])).toBeNull();
  });

  it('skips the slot that was already notified about (per-slot dedup)', () => {
    const s = slot('15:00');
    const entry = baseEntry({
      exactTimes: ['15:00'],
      notifiedSlotStartAtUtc: s.startAtUtc,
    });
    expect(findMatchingSlot(entry, [s])).toBeNull();
  });
});
