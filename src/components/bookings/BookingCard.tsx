import { useState } from 'react';
import type { BookingDetail } from '../../lib/square/customerBookings';

interface Props {
  booking: BookingDetail;
  variant: 'upcoming' | 'past';
  /** When the booking is within 24h AND has a card on file, the second
   *  argument is true — meaning the parent must show the charge-warning
   *  modal and only call the cancel API once the customer accepts. */
  onCancel: (booking: BookingDetail, acceptCharge: boolean) => void;
  onReschedule: (booking: BookingDetail) => void;
  onBookAgain: (booking: BookingDetail) => void;
  busy?: boolean;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function formatPrice(cents: number | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return 'the full service price';
  return `$${(cents / 100).toFixed(2)}`;
}

export function BookingCard({ booking, variant, onCancel, onReschedule, onBookAgain, busy }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const startMs = new Date(booking.startAtUtc).getTime();
  const within24h = startMs - Date.now() < TWENTY_FOUR_HOURS_MS;
  // Within 24h, two cases:
  //   1. card on file (new-customer card-capture flow): cancel allowed,
  //      but only after the customer accepts the charge in a modal.
  //   2. no card (returning customer): keep the existing "call the shop"
  //      message — we have nothing to charge them, so the flow stays
  //      manual.
  const within24hChargeable = within24h && booking.hasCardOnFile === true;
  const lockedReason =
    within24h && !within24hChargeable
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
      {booking.bookingFor && (
        <p className="mb-card__for">
          For <strong>{booking.bookingFor}</strong>
        </p>
      )}
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

      {variant === 'past' && (
        <div className="mb-card__actions">
          <button
            type="button"
            className="mb-btn"
            onClick={() => onBookAgain(booking)}
          >
            Book again
          </button>
        </div>
      )}

      {variant === 'upcoming' && !isCancelled && (
        <div className="mb-card__actions">
          {confirming ? (
            <div
              className={`mb-card__confirm${within24hChargeable ? ' mb-card__confirm--charge' : ''}`}
              role="alertdialog"
              aria-label="Confirm cancellation"
            >
              {within24hChargeable ? (
                <>
                  <p>
                    <strong>Heads up — you're within 24 hours of your appointment.</strong>{' '}
                    Cancelling now will charge your card on file{' '}
                    <strong>{formatPrice(booking.chargeAmountCents)}</strong> (the full service
                    price), per the first-time visitor cancellation policy you accepted at booking.
                  </p>
                  <p className="mb-card__confirm-question">
                    Do you accept this charge and want to cancel?
                  </p>
                </>
              ) : (
                <p>
                  <strong>Cancel this appointment?</strong> Modern Classic asks for 24-hour notice
                  so we can offer the slot to another customer.
                </p>
              )}
              <div className="mb-card__confirm-actions">
                <button
                  type="button"
                  className="mb-btn mb-btn--ghost"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  {within24hChargeable ? 'No, keep it' : 'Keep it'}
                </button>
                <button
                  type="button"
                  className="mb-btn mb-btn--danger"
                  onClick={() => onCancel(booking, within24hChargeable)}
                  disabled={busy}
                >
                  {busy
                    ? 'Cancelling…'
                    : within24hChargeable
                      ? `Yes — cancel & charge ${formatPrice(booking.chargeAmountCents)}`
                      : 'Yes, cancel'}
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
                  className="mb-btn mb-btn--ghost"
                  disabled={!!lockedReason || busy}
                  onClick={() => onReschedule(booking)}
                >
                  Reschedule
                </button>
              </div>
              <button
                type="button"
                className="mb-btn"
                onClick={() => onBookAgain(booking)}
              >
                Book again
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
