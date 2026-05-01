import { useState } from 'react';
import type { AvailabilitySlot } from '../../lib/square/types';
import type { UsualCombo } from '../../lib/booking/usual';
import { formatRelativeSlot } from '../../lib/availability/timing';

interface Props {
  usual: UsualCombo;
  /** 3 or fewer prefetched slots. Empty if no slots within 14 days. */
  quickSlots: AvailabilitySlot[];
  /** True when the soonest slot is within the 7-day "quick pick" window. */
  withinSevenDays: boolean;
  basePath: string;
}

interface QuickRebookResponse {
  ok: boolean;
  bookingId?: string;
  error?: { code: string; detail: string };
}

const SHOP_TZ = 'America/New_York';

const LAST_VISIT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  month: 'long',
  day: 'numeric',
});

const FULL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export default function RebookUsualCard({
  usual,
  quickSlots,
  withinSevenDays,
  basePath,
}: Props) {
  const [pendingSlot, setPendingSlot] = useState<AvailabilitySlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per the doc: hide silently when no slots inside the 14-day window.
  if (quickSlots.length === 0) return null;

  const seeAllUrl = `${basePath}/book?service=${encodeURIComponent(
    usual.serviceVariationId,
  )}&barber=${encodeURIComponent(usual.teamMemberId)}`;

  const seeOtherBarbersUrl = `${basePath}/book?service=${encodeURIComponent(
    usual.serviceVariationId,
  )}`;

  const handleQuickPick = (slot: AvailabilitySlot) => {
    setError(null);
    setPendingSlot(slot);
  };

  const handleConfirm = async () => {
    if (!pendingSlot) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/square/bookings/quick-rebook', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceVariationId: usual.serviceVariationId,
          serviceVariationVersion: usual.serviceVariationVersion,
          teamMemberId: usual.teamMemberId,
          durationMinutes: usual.durationMinutes,
          startAtUtc: pendingSlot.startAtUtc,
        }),
      });
      const data = (await res.json()) as QuickRebookResponse;
      if (data.ok) {
        // Reload — the page will re-evaluate state and replace this card
        // with the upcoming-bookings list.
        window.location.reload();
        return;
      }
      if (data.error?.code === 'SLOT_TAKEN') {
        setError("That time was just taken — pick another.");
      } else {
        setError(data.error?.detail || 'Could not complete your booking. Please try again.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelModal = () => {
    if (busy) return;
    setPendingSlot(null);
    setError(null);
  };

  const lastVisitLabel = `Last visit: ${LAST_VISIT_FMT.format(new Date(usual.lastVisitDate))}`;
  const soonest = quickSlots[0];

  return (
    <section className="mb-rebook" aria-labelledby="mb-rebook-heading">
      <header className="mb-rebook__head">
        <span className="mb-rebook__eyebrow">For you</span>
        <h2 id="mb-rebook-heading">Rebook your usual?</h2>
        <p className="mb-rebook__sub">Same service. Same barber. Faster checkout.</p>
      </header>

      <div className="mb-rebook__details">
        <p className="mb-rebook__combo">
          <strong>{usual.serviceName}</strong> with <strong>{usual.barberName}</strong>
        </p>
        <p className="mb-rebook__last">{lastVisitLabel}</p>
      </div>

      {withinSevenDays && quickSlots.length > 0 ? (
        <>
          <p className="mb-rebook__prompt">Pick one of these to book in two taps:</p>
          <div className="mb-rebook__slots">
            {quickSlots.map((s) => (
              <button
                key={s.startAtUtc}
                type="button"
                className="mb-rebook__slot"
                onClick={() => handleQuickPick(s)}
                disabled={busy}
              >
                {formatRelativeSlot(s.startAtUtc)}
              </button>
            ))}
          </div>
          <div className="mb-rebook__foot">
            <a className="mb-btn mb-btn--ghost" href={seeAllUrl}>
              See all times
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="mb-rebook__prompt">
            {usual.barberName}'s first opening is{' '}
            <strong>{FULL_FMT.format(new Date(soonest.startAtUtc))}</strong>.
          </p>
          <div className="mb-rebook__foot mb-rebook__foot--two">
            <button
              type="button"
              className="mb-btn"
              onClick={() => handleQuickPick(soonest)}
              disabled={busy}
            >
              Book this time
            </button>
            <a className="mb-btn mb-btn--ghost" href={seeOtherBarbersUrl}>
              See other barbers
            </a>
          </div>
        </>
      )}

      {pendingSlot && (
        <div
          className="mb-rebook__modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mb-rebook-modal-title"
        >
          <button
            type="button"
            className="mb-rebook__scrim"
            aria-label="Cancel"
            onClick={handleCancelModal}
          />
          <div className="mb-rebook__panel">
            <h3 id="mb-rebook-modal-title">Confirm your booking</h3>
            <dl className="mb-rebook__panel-summary">
              <div>
                <dt>Service</dt>
                <dd>{usual.serviceName}</dd>
              </div>
              <div>
                <dt>Barber</dt>
                <dd>{usual.barberName}</dd>
              </div>
              <div>
                <dt>When</dt>
                <dd>{FULL_FMT.format(new Date(pendingSlot.startAtUtc))}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{usual.durationMinutes} min</dd>
              </div>
            </dl>
            <p className="mb-rebook__policy">
              <strong>Cancellation policy.</strong> 24-hour notice for changes;
              call <a className="link-gold" href="tel:+17402974462">740-297-4462</a>.
            </p>
            {error && (
              <p className="mb-rebook__error" role="alert">
                {error}
              </p>
            )}
            <div className="mb-rebook__panel-actions">
              <button
                type="button"
                className="mb-btn mb-btn--ghost"
                onClick={handleCancelModal}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="mb-btn"
                onClick={handleConfirm}
                disabled={busy}
              >
                {busy ? 'Booking…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
