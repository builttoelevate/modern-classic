// Book Ahead — list of slots the customer has picked so far.
//
// Renders only when desiredCount > 1. Every entry is a real
// Square slot (no resolution status, no badges, no inline
// alternatives picker — those existed in the old auto-generated
// model and are gone). Sorted chronologically regardless of
// pick order so the customer reads their plan in calendar
// terms, not pick terms.

import type { AvailabilitySlot } from '../../lib/square/types';

interface Props {
  /** All picks combined: state.selectedSlot (when set) + every
   *  entry in state.series.pickedSlots. The parent collects them
   *  so this component stays presentational. Sorted here. */
  picks: AvailabilitySlot[];
  desiredCount: number;
  /** Service price in cents — same across every visit (Book
   *  Ahead locks one service for the whole session). */
  pricePerVisitCents: number | null;
  onRemoveSlot: (startAtUtc: string) => void;
}

const SHOP_TZ = 'America/New_York';

function formatRowDateTime(utc: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(utc));
}

export function BookingPlanPanel({
  picks,
  desiredCount,
  pricePerVisitCents,
  onRemoveSlot,
}: Props) {
  const sorted = [...picks].sort(
    (a, b) => Date.parse(a.startAtUtc) - Date.parse(b.startAtUtc),
  );
  const planFull = picks.length >= desiredCount;
  const totalCents =
    pricePerVisitCents !== null ? pricePerVisitCents * picks.length : null;

  return (
    <section className="bw-plan" aria-label="Your booking plan">
      <header className="bw-plan__head">
        <h3 className="bw-plan__title">Your booking plan</h3>
        <p className="bw-plan__sub">
          {planFull
            ? `All ${desiredCount} ${desiredCount === 1 ? 'visit' : 'visits'} picked`
            : `${picks.length} of ${desiredCount} picked`}
        </p>
      </header>

      {sorted.length === 0 ? (
        <p className="bw-plan__empty">
          Pick a date and time on the calendar above to get started.
        </p>
      ) : (
        <ol className="bw-plan__list">
          {sorted.map((slot, idx) => (
            <li key={slot.startAtUtc} className="bw-plan__row bw-plan__row--ok">
              <span className="bw-plan__num" aria-hidden="true">
                {idx + 1}
              </span>
              <div className="bw-plan__content">
                <div className="bw-plan__when">{formatRowDateTime(slot.startAtUtc)}</div>
              </div>
              <div className="bw-plan__actions">
                <button
                  type="button"
                  className="bw-plan__remove"
                  onClick={() => onRemoveSlot(slot.startAtUtc)}
                  aria-label={`Remove visit on ${formatRowDateTime(slot.startAtUtc)}`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {totalCents !== null && picks.length > 1 ? (
        <footer className="bw-plan__foot">
          <span className="bw-plan__total-label">Total today</span>
          <span className="bw-plan__total">${(totalCents / 100).toFixed(0)}</span>
        </footer>
      ) : null}
    </section>
  );
}
