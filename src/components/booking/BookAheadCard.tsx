// Book Ahead — the upsell card that sits above the Step 3 calendar.
// Two chip rows: frequency ("Every N weeks") and, when frequency > 0,
// total visits to lock in.
//
// "Just this visit" is the default and routes the customer through
// the regular single-booking flow with no change. The card frames
// recurring booking as a loyalty perk ("keep your chair") rather
// than as a cart.

import type { FrequencyWeeks, SeriesCount } from './wizardState';

interface Props {
  frequencyWeeks: FrequencyWeeks;
  count: SeriesCount;
  onFrequencyChange: (frequencyWeeks: FrequencyWeeks) => void;
  onCountChange: (count: SeriesCount) => void;
}

const FREQUENCY_OPTIONS: Array<{ value: FrequencyWeeks; label: string }> = [
  { value: 0, label: 'Just this visit' },
  { value: 2, label: 'Every 2 wk' },
  { value: 3, label: 'Every 3 wk' },
  { value: 4, label: 'Every 4 wk' },
  { value: 6, label: 'Every 6 wk' },
];

const COUNT_OPTIONS: SeriesCount[] = [3, 6, 12];

export function BookAheadCard({
  frequencyWeeks,
  count,
  onFrequencyChange,
  onCountChange,
}: Props) {
  const isRecurring = frequencyWeeks > 0;
  return (
    <section className="bw-bookahead" aria-label="Book ahead">
      <header className="bw-bookahead__head">
        <h3 className="bw-bookahead__title">Book ahead and keep your chair.</h3>
        <p className="bw-bookahead__copy">
          Reserve your next few visits so your spot is already waiting.
        </p>
      </header>

      <div className="bw-bookahead__field">
        <span className="bw-field__label">Frequency</span>
        <div className="bw-chip-row" role="group" aria-label="Visit frequency">
          {FREQUENCY_OPTIONS.map((opt) => {
            const active = opt.value === frequencyWeeks;
            return (
              <button
                key={opt.value}
                type="button"
                className={`bw-chip${active ? ' bw-chip--on' : ''}`}
                aria-pressed={active}
                onClick={() => onFrequencyChange(opt.value)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {isRecurring && (
        <div className="bw-bookahead__field">
          <span className="bw-field__label">Total visits</span>
          <div className="bw-chip-row" role="group" aria-label="Number of visits">
            {COUNT_OPTIONS.map((opt) => {
              const active = opt === count;
              return (
                <button
                  key={opt}
                  type="button"
                  className={`bw-chip${active ? ' bw-chip--on' : ''}`}
                  aria-pressed={active}
                  onClick={() => onCountChange(opt)}
                >
                  {opt} visits
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
