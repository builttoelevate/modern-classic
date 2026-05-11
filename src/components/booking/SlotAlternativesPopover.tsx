// Inline alternatives picker for a Booking Plan row whose intended
// slot is unavailable. Renders directly under the row (no portal,
// no floating positioning) so the layout stays predictable on
// mobile and the customer's tap target stays where their finger is.

import { useEffect, useState } from 'react';
import type { AvailabilitySlot } from '../../lib/square/types';
import { findNearbyAlternatives } from '../../lib/booking/seriesAvailability';

interface Props {
  intendedStartAtUtc: string;
  serviceVariationId: string;
  teamMemberId: string | undefined;
  onPick: (slot: AvailabilitySlot) => void;
  onClose: () => void;
}

const SHOP_TZ = 'America/New_York';

function formatTime(utc: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(utc));
}

function formatDay(utc: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(utc));
}

function sameShopDay(aUtc: string, bUtc: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(aUtc)) === fmt.format(new Date(bUtc));
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'loaded'; slots: AvailabilitySlot[] }
  | { kind: 'error' };

export function SlotAlternativesPopover({
  intendedStartAtUtc,
  serviceVariationId,
  teamMemberId,
  onPick,
  onClose,
}: Props) {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    findNearbyAlternatives(intendedStartAtUtc, serviceVariationId, teamMemberId, 3)
      .then((slots) => {
        if (cancelled) return;
        setState({ kind: 'loaded', slots });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [intendedStartAtUtc, serviceVariationId, teamMemberId]);

  return (
    <div className="bw-altpicker" role="region" aria-label="Pick another time">
      <div className="bw-altpicker__head">
        <span className="bw-altpicker__title">Pick a different time</span>
        <button
          type="button"
          className="bw-altpicker__close"
          onClick={onClose}
          aria-label="Close alternatives"
        >
          ×
        </button>
      </div>

      {state.kind === 'loading' ? (
        <p className="bw-altpicker__msg">Checking nearby openings…</p>
      ) : state.kind === 'error' ? (
        <p className="bw-altpicker__msg">
          Couldn't load alternatives. Try again or remove this visit.
        </p>
      ) : state.slots.length === 0 ? (
        <p className="bw-altpicker__msg">
          No openings nearby. Remove this visit and add it from the calendar instead.
        </p>
      ) : (
        <div className="bw-altpicker__options" role="group">
          {state.slots.map((slot) => {
            const isSameDay = sameShopDay(slot.startAtUtc, intendedStartAtUtc);
            return (
              <button
                key={slot.startAtUtc}
                type="button"
                className="bw-altpicker__option"
                onClick={() => onPick(slot)}
              >
                <span className="bw-altpicker__option-time">
                  {formatTime(slot.startAtUtc)}
                </span>
                <span className="bw-altpicker__option-day">
                  {isSameDay ? 'same day' : formatDay(slot.startAtUtc)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
