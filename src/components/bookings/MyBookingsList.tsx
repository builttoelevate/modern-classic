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

type Tab = 'upcoming' | 'past';

export default function MyBookingsList({ initial, basePath }: Props) {
  const [bookings, setBookings] = useState<CustomerBookings>(initial);
  const [activeTab, setActiveTab] = useState<Tab>('upcoming');
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

  const handleBookAgain = (booking: BookingDetail) => {
    const params = new URLSearchParams({
      service: booking.serviceVariationId,
      barber: booking.barberId,
    });
    window.location.href = `${basePath}/book?${params.toString()}`;
  };

  return (
    <div className="mb-list">
      {toast && (
        <div className="mb-toast" role="status">
          {toast}
        </div>
      )}

      <div className="mb-tabs" role="tablist" aria-label="My bookings">
        <button
          type="button"
          role="tab"
          id="mb-tab-upcoming"
          aria-selected={activeTab === 'upcoming'}
          aria-controls="mb-panel-upcoming"
          tabIndex={activeTab === 'upcoming' ? 0 : -1}
          className={`mb-tab${activeTab === 'upcoming' ? ' mb-tab--active' : ''}`}
          onClick={() => setActiveTab('upcoming')}
        >
          <span>Upcoming</span>
          {bookings.upcoming.length > 0 && (
            <span className="mb-count">{bookings.upcoming.length}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          id="mb-tab-past"
          aria-selected={activeTab === 'past'}
          aria-controls="mb-panel-past"
          tabIndex={activeTab === 'past' ? 0 : -1}
          className={`mb-tab${activeTab === 'past' ? ' mb-tab--active' : ''}`}
          onClick={() => setActiveTab('past')}
        >
          <span>Past</span>
          {bookings.past.length > 0 && (
            <span className="mb-count">{bookings.past.length}</span>
          )}
        </button>
      </div>

      {activeTab === 'upcoming' && (
        <section
          id="mb-panel-upcoming"
          role="tabpanel"
          aria-labelledby="mb-tab-upcoming"
          className="mb-section"
        >
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
                  onBookAgain={handleBookAgain}
                  busy={busyId === b.id}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'past' && (
        <section
          id="mb-panel-past"
          role="tabpanel"
          aria-labelledby="mb-tab-past"
          className="mb-section"
        >
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
                  onBookAgain={handleBookAgain}
                  busy={false}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
