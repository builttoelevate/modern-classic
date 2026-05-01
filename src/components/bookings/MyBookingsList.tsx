import { useState } from 'react';
import type { BookingDetail, CustomerBookings } from '../../lib/square/customerBookings';
import { BookingCard } from './BookingCard';

interface Props {
  initial: CustomerBookings;
  basePath: string;
}

interface BookingsApiResponse {
  ok: boolean;
  upcoming?: BookingDetail[];
  past?: BookingDetail[];
  error?: { code: string; detail: string };
}

interface CancelApiResponse {
  ok: boolean;
  error?: { code: string; detail: string };
}

export default function MyBookingsList({ initial, basePath }: Props) {
  const [bookings, setBookings] = useState<CustomerBookings>(initial);
  const [showPast, setShowPast] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch('/api/square/customer/bookings', {
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        window.location.href = `${basePath}/sign-in?redirect=${encodeURIComponent(`${basePath}/my-bookings`)}`;
        return;
      }
      const data = (await res.json()) as BookingsApiResponse;
      if (data.ok) {
        setBookings({
          upcoming: data.upcoming ?? [],
          past: data.past ?? [],
        });
      }
    } catch {
      // Silent — the existing list keeps showing.
    }
  };

  const handleCancel = async (booking: BookingDetail) => {
    setBusyId(booking.id);
    try {
      // Content-Type: application/json keeps Astro's CSRF protection from
      // treating this bodyless POST as a cross-site form submission.
      const res = await fetch(`/api/square/bookings/${encodeURIComponent(booking.id)}/cancel`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = (await res.json()) as CancelApiResponse;
      if (data.ok) {
        setToast('Appointment cancelled.');
        await refresh();
      } else if (data.error?.code === 'TOO_LATE_TO_CANCEL') {
        setToast('Within 24 hours — please call the shop at 740-297-4462.');
        await refresh();
      } else {
        setToast(data.error?.detail || 'Could not cancel. Please try again.');
      }
    } catch {
      setToast('Network error. Please try again.');
    } finally {
      setBusyId(null);
      setTimeout(() => setToast(null), 5000);
    }
  };

  const handleReschedule = (booking: BookingDetail) => {
    const params = new URLSearchParams({ reschedule: booking.id });
    window.location.href = `${basePath}/book?${params.toString()}`;
  };

  return (
    <div className="mb-list">
      {toast && (
        <div className="mb-toast" role="status">
          {toast}
        </div>
      )}

      <section className="mb-section">
        <header className="mb-section-head">
          <h2>Upcoming</h2>
          {bookings.upcoming.length > 0 && (
            <span className="mb-count">{bookings.upcoming.length}</span>
          )}
        </header>

        {bookings.upcoming.length === 0 ? (
          <div className="mb-empty">
            <p>No upcoming appointments.</p>
            <a className="mb-btn" href={`${basePath}/book`}>
              Book a visit
            </a>
          </div>
        ) : (
          <div className="mb-grid">
            {bookings.upcoming.map((b) => (
              <BookingCard
                key={b.id}
                booking={b}
                variant="upcoming"
                onCancel={handleCancel}
                onReschedule={handleReschedule}
                busy={busyId === b.id}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-section">
        <header className="mb-section-head">
          <button
            type="button"
            className="mb-toggle"
            aria-expanded={showPast}
            onClick={() => setShowPast((v) => !v)}
          >
            <span>{showPast ? 'Hide past appointments' : 'Show past appointments'}</span>
            {bookings.past.length > 0 && <span className="mb-count">{bookings.past.length}</span>}
            <span className="mb-toggle__icon" aria-hidden="true">
              {showPast ? '–' : '+'}
            </span>
          </button>
        </header>

        {showPast && (
          <>
            {bookings.past.length === 0 ? (
              <p className="mb-empty mb-empty--minor">No past appointments yet.</p>
            ) : (
              <div className="mb-grid">
                {bookings.past.map((b) => (
                  <BookingCard
                    key={b.id}
                    booking={b}
                    variant="past"
                    onCancel={handleCancel}
                    onReschedule={handleReschedule}
                    busy={false}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
