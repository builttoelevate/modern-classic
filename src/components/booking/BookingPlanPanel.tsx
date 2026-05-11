// Book Ahead — the booking-plan panel that appears below the calendar
// once the customer has picked their first slot AND a recurring
// frequency. Renders the full series (first visit + all generated
// visits) as a compact vertical list. Each row shows date/time,
// availability badge, and a remove button.
//
// PR 1 keeps this read-mostly: removed rows drop from the plan, but
// 'taken' / 'barber-off' rows show an inert "Unavailable" badge.
// PR 2 wires the inline alternatives picker so unavailable rows can
// be swapped without leaving the screen.

import type { AvailabilitySlot } from '../../lib/square/types';
import type { GeneratedSlot, GeneratedSlotStatus } from './wizardState';

interface PlanRow {
  /** Stable key — for the first visit, the real slot's startAtUtc; for
   *  generated rows, the intendedStartAtUtc (which equals slot.startAtUtc
   *  when status === 'available'). */
  key: string;
  startAtUtc: string;
  status: GeneratedSlotStatus;
  /** True for the customer's hand-picked first visit. Drives the
   *  "First visit" badge and disables the remove button (you can't
   *  drop the slot you just clicked). */
  isFirst: boolean;
}

interface Props {
  firstSlot: AvailabilitySlot;
  generatedSlots: GeneratedSlot[];
  resolving: boolean;
  /** Service price in cents, used to compute the total. Same across
   *  every visit (Book Ahead locks one service for the whole series). */
  pricePerVisitCents: number | null;
  onRemoveSlot: (intendedStartAtUtc: string) => void;
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

function statusBadge(status: GeneratedSlotStatus): { label: string; tone: 'ok' | 'warn' | 'dim' } {
  switch (status) {
    case 'available':
      return { label: 'Available', tone: 'ok' };
    case 'taken':
      return { label: 'Time taken', tone: 'warn' };
    case 'barber-off':
      return { label: 'Barber off', tone: 'warn' };
    case 'out-of-horizon':
      return { label: 'Past 1-year limit', tone: 'dim' };
    case 'pending':
      return { label: 'Checking…', tone: 'dim' };
  }
}

export function BookingPlanPanel({
  firstSlot,
  generatedSlots,
  resolving,
  pricePerVisitCents,
  onRemoveSlot,
}: Props) {
  const rows: PlanRow[] = [
    {
      key: firstSlot.startAtUtc,
      startAtUtc: firstSlot.startAtUtc,
      status: 'available',
      isFirst: true,
    },
    ...generatedSlots.map<PlanRow>((g) => ({
      key: g.intendedStartAtUtc,
      startAtUtc: g.intendedStartAtUtc,
      status: g.status,
      isFirst: false,
    })),
  ];

  const bookableCount = rows.filter((r) => r.status === 'available').length;
  const totalCents =
    pricePerVisitCents !== null ? pricePerVisitCents * bookableCount : null;

  return (
    <section className="bw-plan" aria-label="Your booking plan">
      <header className="bw-plan__head">
        <h3 className="bw-plan__title">Your booking plan</h3>
        <p className="bw-plan__sub">
          {resolving
            ? 'Checking availability…'
            : `${bookableCount} of ${rows.length} ${rows.length === 1 ? 'visit' : 'visits'} ready to book`}
        </p>
      </header>

      <ol className="bw-plan__list">
        {rows.map((row, idx) => {
          const badge = statusBadge(row.status);
          const showRemove = !row.isFirst && row.status !== 'pending';
          return (
            <li key={row.key} className={`bw-plan__row bw-plan__row--${badge.tone}`}>
              <span className="bw-plan__num" aria-hidden="true">
                {idx + 1}
              </span>
              <div className="bw-plan__content">
                <div className="bw-plan__when">{formatRowDateTime(row.startAtUtc)}</div>
                <div className="bw-plan__meta">
                  {row.isFirst ? (
                    <span className="bw-plan__pill bw-plan__pill--first">First visit</span>
                  ) : null}
                  <span className={`bw-plan__pill bw-plan__pill--${badge.tone}`}>
                    {badge.label}
                  </span>
                </div>
              </div>
              {showRemove ? (
                <button
                  type="button"
                  className="bw-plan__remove"
                  onClick={() => onRemoveSlot(row.startAtUtc)}
                  aria-label={`Remove visit on ${formatRowDateTime(row.startAtUtc)}`}
                >
                  Remove
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>

      {totalCents !== null && bookableCount > 1 ? (
        <footer className="bw-plan__foot">
          <span className="bw-plan__total-label">Total today</span>
          <span className="bw-plan__total">${(totalCents / 100).toFixed(0)}</span>
        </footer>
      ) : null}
    </section>
  );
}
