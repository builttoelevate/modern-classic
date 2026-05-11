// Book Ahead — count picker that sits above the Step 3 calendar.
// Customer indicates how many visits they want to book in this
// session. Default 1 (single visit, behavior unchanged from a
// non-Book-Ahead booking). Picking 2-4 keeps them on Step 3
// after each slot tap so they can build out the plan.
//
// When the customer drops the count BELOW the number of slots
// they've already picked, the parent reducer truncates the plan
// to fit. We surface that as a brief toast inside this card —
// silent deletion would feel like a bug.

import { useEffect, useRef, useState } from 'react';
import type { DesiredCount } from './wizardState';

interface Props {
  desiredCount: DesiredCount;
  /** Total picks currently in the plan (selectedSlot + pickedSlots).
   *  Used to detect when a count change drops slots so we can
   *  surface the reconciliation toast. */
  currentPlanLength: number;
  onCountChange: (next: DesiredCount) => void;
}

const COUNT_OPTIONS: DesiredCount[] = [1, 2, 3, 4];

export function BookAheadCard({
  desiredCount,
  currentPlanLength,
  onCountChange,
}: Props) {
  const [toast, setToast] = useState<string | null>(null);
  // Track the last-seen plan length so we only fire the toast on
  // an actual reconciliation (not on every plan-length change like
  // adds and removes).
  const lastPlanLenRef = useRef(currentPlanLength);
  const lastDesiredRef = useRef(desiredCount);

  useEffect(() => {
    const desiredChanged = lastDesiredRef.current !== desiredCount;
    const planShrunk = currentPlanLength < lastPlanLenRef.current;
    if (desiredChanged && planShrunk) {
      const dropped = lastPlanLenRef.current - currentPlanLength;
      setToast(
        `Removed ${dropped} ${dropped === 1 ? 'visit' : 'visits'} to match the new count.`,
      );
      const t = setTimeout(() => setToast(null), 3000);
      lastPlanLenRef.current = currentPlanLength;
      lastDesiredRef.current = desiredCount;
      return () => clearTimeout(t);
    }
    lastPlanLenRef.current = currentPlanLength;
    lastDesiredRef.current = desiredCount;
  }, [currentPlanLength, desiredCount]);

  return (
    <section className="bw-bookahead" aria-label="Book ahead">
      <header className="bw-bookahead__head">
        <h3 className="bw-bookahead__title">Book ahead and keep your chair.</h3>
        <p className="bw-bookahead__copy">
          Reserve up to four visits in one go. Pick each date and time
          yourself.
        </p>
      </header>

      <div className="bw-bookahead__field">
        <span className="bw-field__label">How many visits today?</span>
        <div className="bw-chip-row" role="group" aria-label="Number of visits">
          {COUNT_OPTIONS.map((opt) => {
            const active = opt === desiredCount;
            return (
              <button
                key={opt}
                type="button"
                className={`bw-chip${active ? ' bw-chip--on' : ''}`}
                aria-pressed={active}
                onClick={() => onCountChange(opt)}
              >
                {opt} {opt === 1 ? 'visit' : 'visits'}
              </button>
            );
          })}
        </div>
      </div>

      {toast && (
        <p className="bw-bookahead__toast" role="status">
          {toast}
        </p>
      )}
    </section>
  );
}
