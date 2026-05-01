// Phase 6 Part B — detect a customer's "usual" service+barber combo.
//
// Looks at past bookings only, excludes terminal-but-not-completed
// statuses, groups by (variation, team member), and picks the most
// frequent combo. Tiebreaker: most recent occurrence.

import type { BookingDetail } from '../square/customerBookings';
import type { Booking } from '../square/types';

const EXCLUDED_STATUSES = new Set<Booking['status']>([
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_SELLER',
  'NO_SHOW',
  'DECLINED',
]);

export interface UsualCombo {
  serviceVariationId: string;
  serviceVariationVersion: number;
  teamMemberId: string;
  durationMinutes: number;
  serviceName: string;
  barberName: string;
  /** ISO UTC timestamp of the most-recent occurrence of this combo. */
  lastVisitDate: string;
}

interface ComboBucket {
  combo: UsualCombo;
  count: number;
  lastSeenMs: number;
}

function comboKey(b: BookingDetail): string {
  return `${b.serviceVariationId}|${b.barberId}`;
}

/**
 * Pick the customer's usual combo from their booking history.
 * `activeBarberIds` — the set of currently bookable team member ids. If
 * the chosen combo's barber isn't active, we discard and try the next.
 */
export function findUsualCombo(
  bookings: BookingDetail[],
  activeBarberIds: Set<string>,
): UsualCombo | null {
  const now = Date.now();
  const buckets = new Map<string, ComboBucket>();

  for (const b of bookings) {
    if (EXCLUDED_STATUSES.has(b.status)) continue;
    const startMs = new Date(b.startAtUtc).getTime();
    if (startMs >= now) continue; // past only
    if (!b.serviceVariationId || !b.barberId) continue;

    const key = comboKey(b);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      if (startMs > existing.lastSeenMs) {
        existing.lastSeenMs = startMs;
        existing.combo.lastVisitDate = b.startAtUtc;
        existing.combo.serviceVariationVersion = b.serviceVariationVersion;
        existing.combo.durationMinutes = b.durationMinutes;
        existing.combo.serviceName = b.serviceName;
        existing.combo.barberName = b.barberName;
      }
    } else {
      buckets.set(key, {
        count: 1,
        lastSeenMs: startMs,
        combo: {
          serviceVariationId: b.serviceVariationId,
          serviceVariationVersion: b.serviceVariationVersion,
          teamMemberId: b.barberId,
          durationMinutes: b.durationMinutes,
          serviceName: b.serviceName,
          barberName: b.barberName,
          lastVisitDate: b.startAtUtc,
        },
      });
    }
  }

  if (buckets.size === 0) return null;

  // Most frequent first; tiebreak on most-recent occurrence.
  const ranked = Array.from(buckets.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeenMs - a.lastSeenMs;
  });

  // Walk down until we find a combo whose barber is still active.
  for (const bucket of ranked) {
    if (activeBarberIds.has(bucket.combo.teamMemberId)) {
      return bucket.combo;
    }
  }
  return null;
}
