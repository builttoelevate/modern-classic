import { useState } from 'react';
import type { BookingDetail } from '../../lib/square/customerBookings';

interface Props {
  booking: BookingDetail;
  variant: 'upcoming' | 'past';
  onCancel: (booking: BookingDetail) => void;
  onReschedule: (booking: BookingDetail) => void;
  busy?: boolean;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function BookingCard({ booking, variant, onCancel, onReschedule, busy }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const startMs = new Date(booking.startAtUtc).getTime();
  const within24h = startMs - Date.now() < TWENTY_FOUR_HOURS_MS;
  const lockedReason = within24h
    ? 'Within 24 hours? Call the shop at 740-297-4462 to cancel or reschedule.'
    : null;

  const isCancelled =
    booking.status === 'CANCELLED_BY_CUSTOMER' ||
    booking.status === 'CANCELLED_BY_SELLER' ||
    booking.status === 'DECLINED' ||
    booking.status === 'NO_SHOW';

  const statusLabel = (() => {
    switch (booking.status) {
      case 'PENDING':
        return 'Pending';
      case 'ACCEPTED':
        return variant === 'upcoming' ? 'Confirmed' : 'Completed';
      case 'CANCELLED_BY_CUSTOMER':
        return 'Cancelled';
      case 'CANCELLED_BY_SELLER':
        return 'Cancelled by shop';
      case 'NO_SHOW':
        return 'No-show';
      case 'DECLINED':
        return 'Declined';
      default:
        return '';
    }
  })();

  return (
    <article className={`mb-card mb-card--${variant}${isCancelled ? ' mb-card--cancelled' : ''}`}>
      <header className="mb-card__head">
        <h3 className="mb-card__when">{booking.startAtLocal}</h3>
        {statusLabel && <span className="mb-card__status">{statusLabel}</span>}
      </header>
      <dl className="mb-card__details">
        <div>
          <dt>Service</dt>
          <dd>{booking.serviceName}</dd>
        </div>
        <div>
          <dt>Barber</dt>
          <dd>{booking.barberName}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{booking.durationMinutes} min</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>{booking.priceDisplay}</dd>
        </div>
        {booking.customerNote && (
          <div className="mb-card__note">
            <dt>Note</dt>
            <dd>{booking.customerNote}</dd>
          </div>
        )}
      </dl>

      {variant === 'upcoming' && !isCancelled && (
        <div className="mb-card__actions">
          {confirming ? (
            <div className="mb-card__confirm" role="alertdialog" aria-label="Confirm cancellation">
              <p>
                <strong>Cancel this appointment?</strong> Modern Classic asks for 24-hour notice
                so we can offer the slot to another customer.
              </p>
              <div className="mb-card__confirm-actions">
                <button
                  type="button"
                  className="mb-btn mb-btn--ghost"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  className="mb-btn mb-btn--danger"
                  onClick={() => onCancel(booking)}
                  disabled={busy}
                >
                  {busy ? 'Cancelling…' : 'Yes, cancel'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className="mb-action-wrap"
                onMouseEnter={() => lockedReason && setTooltipOpen(true)}
                onMouseLeave={() => setTooltipOpen(false)}
                onFocus={() => lockedReason && setTooltipOpen(true)}
                onBlur={() => setTooltipOpen(false)}
              >
                <button
                  type="button"
                  className="mb-btn mb-btn--ghost"
                  disabled={!!lockedReason || busy}
                  aria-describedby={lockedReason ? `tooltip-${booking.id}` : undefined}
                  onClick={() => setConfirming(true)}
                >
                  Cancel
                </button>
                {lockedReason && tooltipOpen && (
                  <span className="mb-tooltip" id={`tooltip-${booking.id}`} role="tooltip">
                    {lockedReason}
                  </span>
                )}
              </div>
              <div
                className="mb-action-wrap"
                onMouseEnter={() => lockedReason && setTooltipOpen(true)}
                onMouseLeave={() => setTooltipOpen(false)}
              >
                <button
                  type="button"
                  className="mb-btn"
                  disabled={!!lockedReason || busy}
                  onClick={() => onReschedule(booking)}
                >
                  Reschedule
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}
