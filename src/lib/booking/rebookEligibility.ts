// Phase 6 Part B — single source of truth for "show the rebook card."
//
// Pure function so the my-bookings page and any future surface can ask
// the same question without duplicating logic.

import type { BookingDetail } from '../square/customerBookings';
import type { UsualCombo } from './usual';

interface ShouldShowInput {
  usualCombo: UsualCombo | null;
  upcomingBookings: BookingDetail[];
}

export function shouldShowRebookCard({ usualCombo, upcomingBookings }: ShouldShowInput): boolean {
  if (usualCombo === null) return false;
  if (upcomingBookings.length > 0) return false;
  return true;
}
