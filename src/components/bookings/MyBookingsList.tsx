import { useState, type ReactNode } from 'react';
import type { BookingDetail, CustomerBookings } from '../../lib/square/customerBookings';
import { encodeGroupPreset } from '../../lib/booking/wizardPreselect';
import type { GroupBookingPreset } from '../booking/group/groupWizardState';
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
  /** Echoed back when ok=true and the cancellation was inside the 24h
   *  window with a card on file — carries the charge result so the UI
   *  can show the right toast (success vs. card-declined). */
  charge?:
    | { ok: true; amountCents: number }
    | { ok: false; detail: string };
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

  const handleCancel = async (booking: BookingDetail, acceptCharge: boolean) => {
    setBusyId(booking.id);
    try {
      // Content-Type: application/json keeps Astro's CSRF protection from
      // treating this bodyless POST as a cross-site form submission.
      // When the user is inside the 24h window AND has a card on file,
      // BookingCard sets acceptCharge=true after they tap the
      // "Yes — cancel & charge" button on the warning modal. The server
      // refuses any late-cancel that doesn't carry that flag.
      const res = await fetch(`/api/square/bookings/${encodeURIComponent(booking.id)}/cancel`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptCharge }),
      });
      const data = (await res.json()) as CancelApiResponse;
      if (data.ok) {
        if (data.charge?.ok === true) {
          setToast(
            `Appointment cancelled. Card charged $${(data.charge.amountCents / 100).toFixed(2)}.`,
          );
        } else if (data.charge && data.charge.ok === false) {
          setToast(
            `Cancelled, but card charge failed: ${data.charge.detail}. The shop will follow up.`,
          );
        } else {
          setToast('Appointment cancelled.');
        }
        // Optimistically drop the cancelled row out of upcoming.
        // Without this, a refresh() failure (Square hiccup, transient
        // 5xx) leaves the cancelled card on screen as if still
        // confirmed — exactly what we saw when 4 Book-Ahead visits
        // were cancelled but stayed visible in the list. The refresh
        // below still runs to pull any server-side changes (e.g.
        // status now PAST), but the user sees the row vanish
        // immediately regardless of whether the refetch succeeds.
        setBookings((prev) => ({
          upcoming: prev.upcoming.filter((b) => b.id !== booking.id),
          past: prev.past,
        }));
        await refresh();
      } else if (data.error?.code === 'CANCEL_REQUIRES_CHARGE_ACCEPT') {
        // Should not reach here in normal use — BookingCard surfaces
        // its modal before calling onCancel with acceptCharge=true.
        // Fall through with a generic prompt so a stale tab doesn't
        // silently swallow the click.
        setToast('Within 24 hours — confirm the charge to cancel.');
      } else if (data.error?.code === 'TOO_LATE_TO_CANCEL') {
        setToast('Within 24 hours — please email modernclassicbarbershop@protonmail.com.');
        await refresh();
      } else {
        setToast(data.error?.detail || 'Could not cancel. Please try again.');
      }
    } catch {
      setToast('Network error. Please try again.');
    } finally {
      setBusyId(null);
      setTimeout(() => setToast(null), 7000);
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

  // Rebook every member of a group in one go. We encode the original
  // services + mode + back-to-back barber into a preset blob that
  // /book/group decodes and feeds straight into the wizard, landing
  // the customer on the Time step with everything pre-selected.
  const handleBookWholeGroup = (members: BookingDetail[]) => {
    if (members.length < 2) return;
    const mode = members[0]?.groupMode;
    if (mode !== 'back-to-back' && mode !== 'all-at-once') return;
    // Back-to-back groups share one barber across every member, so we
    // can pull it from member 0. All-at-once groups intentionally use
    // different barbers per member — we omit teamMemberId in that case
    // and let the wizard's slot-finder reassign them.
    const teamMemberId =
      mode === 'back-to-back' ? members[0]?.barberId : undefined;
    const preset: GroupBookingPreset = {
      mode,
      teamMemberId,
      members: members.map((m) => ({
        serviceVariationId: m.serviceVariationId,
        // bookingFor is undefined for the parent's own slot and set to
        // the linked-person's display name otherwise — exactly what
        // the wizard needs to re-pin the chip on Step 6.
        displayName: m.bookingFor ?? '',
        isSelf: !m.bookingFor,
      })),
    };
    const encoded = encodeGroupPreset(preset);
    window.location.href = `${basePath}/book/group?preset=${encoded}`;
  };

  // Walk the list once, gathering bookings that share a groupId into a
  // single visual container while leaving solo bookings as-is. The
  // container is purely presentational — each booking inside still owns
  // its own cancel/reschedule actions and its own Square id, so a
  // customer can drop one half of a back-to-back without touching the
  // other.
  const renderList = (
    list: BookingDetail[],
    variant: 'upcoming' | 'past',
  ): ReactNode[] => {
    const seenGroupIds = new Set<string>();
    const out: ReactNode[] = [];
    for (const b of list) {
      if (b.groupId) {
        if (seenGroupIds.has(b.groupId)) continue;
        seenGroupIds.add(b.groupId);
        const members = list
          .filter((x) => x.groupId === b.groupId)
          .sort((a, c) => (a.groupPosition ?? 0) - (c.groupPosition ?? 0));
        if (members.length > 1) {
          out.push(
            <BookingGroup
              key={`group-${b.groupId}`}
              members={members}
              onBookWholeGroup={handleBookWholeGroup}
            >
              {members.map((m) => (
                <BookingCard
                  key={m.id}
                  booking={m}
                  variant={variant}
                  onCancel={handleCancel}
                  onReschedule={handleReschedule}
                  onBookAgain={handleBookAgain}
                  busy={busyId === m.id}
                />
              ))}
            </BookingGroup>,
          );
          continue;
        }
        // Single visible member of a group (e.g. a linked person whose
        // booking has been pruned by the lookback window): fall through
        // and render as a normal solo card.
      }
      out.push(
        <BookingCard
          key={b.id}
          booking={b}
          variant={variant}
          onCancel={handleCancel}
          onReschedule={handleReschedule}
          onBookAgain={handleBookAgain}
          busy={busyId === b.id}
        />,
      );
    }
    return out;
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
            <div className="mb-grid">{renderList(bookings.upcoming, 'upcoming')}</div>
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
            <div className="mb-grid">{renderList(bookings.past, 'past')}</div>
          )}
        </section>
      )}
    </div>
  );
}

// Visual container for the members of a group booking. Renders a small
// header naming the group ("Group of 2 · Back-to-back" or "all at once")
// and a tinted frame so members read as a unit, while still leaving
// each child card fully independent for cancel/reschedule.
function BookingGroup({
  members,
  onBookWholeGroup,
  children,
}: {
  members: BookingDetail[];
  onBookWholeGroup: (members: BookingDetail[]) => void;
  children: ReactNode;
}): JSX.Element {
  const total = members[0]?.groupTotal ?? members.length;
  const mode = members[0]?.groupMode;
  const modeLabel =
    mode === 'all-at-once' ? 'All at once' : mode === 'back-to-back' ? 'Back-to-back' : null;
  // Only offer the one-tap rebook when the mode is recognized — without
  // it the wizard wouldn't know whether to head into the all-at-once or
  // back-to-back branch on the next step.
  const canRebookGroup = mode === 'all-at-once' || mode === 'back-to-back';
  return (
    <div
      className="mb-group"
      role="group"
      aria-label={`Group of ${total} appointments${modeLabel ? `, ${modeLabel.toLowerCase()}` : ''}`}
    >
      <header className="mb-group__head">
        <span className="mb-group__title">
          Group of {total}
          {modeLabel ? <span className="mb-group__mode"> · {modeLabel}</span> : null}
        </span>
        <span className="mb-group__hint">Each appointment can be cancelled or rescheduled separately.</span>
      </header>
      <div className="mb-group__members">{children}</div>
      {canRebookGroup && (
        <div className="mb-group__actions">
          <button
            type="button"
            className="mb-btn"
            onClick={() => onBookWholeGroup(members)}
          >
            Book whole group again
          </button>
        </div>
      )}
    </div>
  );
}
