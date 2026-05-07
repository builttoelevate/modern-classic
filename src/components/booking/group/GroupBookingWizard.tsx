import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Barber, Service } from '../../../lib/square/types';
import type { GroupSlot } from '../../../lib/booking/groupAvailability';
import {
  canAdvance,
  makeInitialState,
  reducer,
  type GroupMode,
} from './groupWizardState';

export interface BookingForOption {
  customerId: string;
  displayName: string;
  isSelf: boolean;
}

interface Props {
  services: Service[];
  barbers: Barber[];
  /** Pre-fill the parent block when a customer is signed in. */
  signedInCustomer?: {
    givenName: string;
    familyName: string;
    email: string;
    phone: string;
  };
  /** Self + already-linked people. Step 6 surfaces this so the parent
   * can pick saved names instead of typing every time. Empty/length-1
   * (just self) hides the dropdown and we fall back to plain inputs. */
  bookingForOptions?: BookingForOption[];
}

const SHOP_TZ = 'America/New_York';
const STEP_LABELS = [
  'How many',
  'Services',
  'Style',
  'Barber',
  'Time',
  'Details',
  'Confirm',
];

/** All sizes the booking spec supports (the matcher caps at 4 anyway).
 * Step 1 narrows this further at runtime based on how many active
 * barbers the shop has — see resolveSizeOptions below. */
const ABSOLUTE_SIZE_OPTIONS: Array<2 | 3 | 4> = [2, 3, 4];

/** Cap the picker at min(4, active-barbers). All-at-once mode requires
 * N distinct barbers free at the same minute — picking 4 at a 3-barber
 * shop is always infeasible, so we don't even offer it. If the shop
 * grows to 4 barbers, the cap auto-bumps; no code change needed. */
function resolveSizeOptions(barberCount: number): Array<2 | 3 | 4> {
  const cap = Math.min(4, Math.max(2, barberCount));
  return ABSOLUTE_SIZE_OPTIONS.filter((n) => n <= cap) as Array<2 | 3 | 4>;
}

export default function GroupBookingWizard({
  services,
  barbers,
  signedInCustomer,
  bookingForOptions,
}: Props) {
  const savedPeople = bookingForOptions ?? [];
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    makeInitialState(2),
  );

  // Scroll the wizard root into view on every step change. Without
  // this, hitting Continue at the bottom of a long step (e.g. Step 2
  // with 4 members each picking a service) leaves the user staring at
  // the buttons of the *previous* step's content area; they have to
  // manually scroll up to see the next question. Same pattern as the
  // single-flow BookingWizard: skip the very first render, honor
  // prefers-reduced-motion.
  const rootRef = useRef<HTMLDivElement>(null);
  const lastScrolledStepRef = useRef<number>(state.step);
  useEffect(() => {
    if (lastScrolledStepRef.current === state.step) return;
    lastScrolledStepRef.current = state.step;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
    if (rootRef.current) {
      rootRef.current.scrollIntoView({ behavior, block: 'start' });
    } else if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior });
    }
  }, [state.step]);

  // Pre-fill parent block from session, once.
  useEffect(() => {
    if (signedInCustomer && state.step === 1 && state.parent.email === '') {
      dispatch({
        type: 'SET_PARENT',
        patch: {
          givenName: signedInCustomer.givenName,
          familyName: signedInCustomer.familyName,
          email: signedInCustomer.email,
          phone: signedInCustomer.phone,
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the wizard reaches Step 5 (calendar), fetch group availability
  // from the API based on the picks so far. We drop slots into state so
  // Step 5 only renders dates that are actually feasible.
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  useEffect(() => {
    if (state.step !== 5) return;
    if (state.availableSlots !== null) return; // already loaded
    if (!state.mode) return;
    if (state.mode === 'back-to-back' && !state.selectedBarber) return;
    let cancelled = false;
    setSlotsLoading(true);
    setSlotsError(null);
    const body = {
      mode: state.mode,
      members: state.members.map((m) => ({
        key: m.key,
        displayName: m.displayName,
        serviceId: m.service!.id,
      })),
      teamMemberId:
        state.mode === 'back-to-back' ? state.selectedBarber!.id : undefined,
    };
    fetch('/api/square/group-availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (!d.ok) {
          setSlotsError(d?.error?.detail ?? 'Could not load openings.');
          dispatch({ type: 'SET_AVAILABLE_SLOTS', slots: [] });
          return;
        }
        dispatch({ type: 'SET_AVAILABLE_SLOTS', slots: d.slots as GroupSlot[] });
      })
      .catch(() => {
        if (cancelled) return;
        setSlotsError('Network error. Try again.');
        dispatch({ type: 'SET_AVAILABLE_SLOTS', slots: [] });
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    state.step,
    state.mode,
    state.selectedBarber,
    state.members,
    state.availableSlots,
  ]);

  const submit = async () => {
    if (!state.selectedSlot || !state.mode) return;
    dispatch({ type: 'SET_STATUS', status: { kind: 'submitting' } });
    const assignments = buildAssignments(state.members, state.selectedSlot).map(
      (a, idx) => {
        const m = state.members[idx];
        return {
          ...a,
          who: m.who,
          existingCustomerId: m.existingCustomerId,
        };
      },
    );
    try {
      const res = await fetch('/api/square/group-bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: state.mode,
          assignments,
          parent: {
            givenName: state.parent.givenName.trim(),
            familyName: state.parent.familyName.trim(),
            email: state.parent.email.trim(),
            phone: state.parent.phone.replace(/\D/g, ''),
          },
          groupNote: state.groupNote.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!d.ok) {
        dispatch({
          type: 'SET_STATUS',
          status: {
            kind: 'error',
            message: d?.error?.detail ?? 'Could not book the group.',
          },
        });
        return;
      }
      dispatch({
        type: 'SET_STATUS',
        status: {
          kind: 'success',
          groupId: d.groupId,
          bookings: d.bookings,
          failures: d.failures,
        },
      });
    } catch {
      dispatch({
        type: 'SET_STATUS',
        status: {
          kind: 'error',
          message: 'Network error. Please call us at 740-297-4462.',
        },
      });
    }
  };

  const ready = canAdvance(state);

  return (
    <div className="gw" ref={rootRef}>
      <ol className="gw__steps" aria-label="Group booking steps">
        {STEP_LABELS.map((label, i) => {
          const stepNum = (i + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
          const isActive = state.step === stepNum;
          const isDone = stepNum < state.step;
          // Step 4 (Barber) is skipped in all-at-once mode after Step 3.
          const skipped = stepNum === 4 && state.mode === 'all-at-once';
          return (
            <li
              key={label}
              className={`gw__step ${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''} ${skipped ? 'is-skipped' : ''}`}
            >
              <span className="gw__step-num">{stepNum}</span>
              <span className="gw__step-label">{label}</span>
            </li>
          );
        })}
      </ol>

      {state.status.kind === 'success' ? (
        <SuccessScreen state={state} onReset={() => dispatch({ type: 'RESET' })} />
      ) : (
        <div className="gw__body">
          {state.step === 1 && (
            <Step1Size
              size={state.size}
              barberCount={barbers.length}
              onPick={(size) => {
                dispatch({ type: 'SET_SIZE', size });
                dispatch({ type: 'NEXT' });
              }}
            />
          )}
          {state.step === 2 && (
            <Step2Services
              members={state.members}
              services={services}
              onPick={(key, service) =>
                dispatch({ type: 'SET_MEMBER_SERVICE', key, service })
              }
            />
          )}
          {state.step === 3 && (
            <Step3Mode
              members={state.members}
              onPick={(mode) => {
                dispatch({ type: 'SET_MODE', mode });
                if (mode === 'all-at-once') {
                  dispatch({ type: 'GO_TO', step: 5 });
                } else {
                  dispatch({ type: 'NEXT' });
                }
              }}
            />
          )}
          {state.step === 4 && (
            <Step4Barber
              members={state.members}
              barbers={barbers}
              selected={state.selectedBarber}
              onPick={(b) => dispatch({ type: 'SET_BARBER', barber: b })}
            />
          )}
          {state.step === 5 && (
            <Step5Time
              loading={slotsLoading}
              error={slotsError}
              slots={state.availableSlots ?? []}
              selected={state.selectedSlot}
              onPick={(slot) => dispatch({ type: 'SET_SLOT', slot })}
              onRetry={() =>
                dispatch({ type: 'SET_AVAILABLE_SLOTS', slots: null })
              }
            />
          )}
          {state.step === 6 && (
            <Step6Details
              parent={state.parent}
              members={state.members}
              groupNote={state.groupNote}
              savedPeople={savedPeople}
              onParent={(patch) => dispatch({ type: 'SET_PARENT', patch })}
              onMemberName={(key, name) =>
                dispatch({ type: 'SET_MEMBER_NAME', key, name })
              }
              onMemberWho={(payload) => dispatch({ type: 'SET_MEMBER_WHO', ...payload })}
              onGroupNote={(note) => dispatch({ type: 'SET_GROUP_NOTE', note })}
            />
          )}
          {state.step === 7 && (
            <Step7Confirm
              state={state}
              onConfirm={submit}
            />
          )}

          <div className="gw__nav">
            {state.step > 1 && state.step !== 5 && (
              <button
                type="button"
                className="bw-btn bw-btn--ghost"
                onClick={() => {
                  // From Step 5, going back means returning to Step 4
                  // (back-to-back) or Step 3 (all-at-once).
                  if (state.step === 5 && state.mode === 'all-at-once') {
                    dispatch({ type: 'GO_TO', step: 3 });
                  } else {
                    dispatch({ type: 'BACK' });
                  }
                }}
              >
                Back
              </button>
            )}
            {state.step === 5 && (
              <button
                type="button"
                className="bw-btn bw-btn--ghost"
                onClick={() => {
                  if (state.mode === 'all-at-once') {
                    dispatch({ type: 'GO_TO', step: 3 });
                  } else {
                    dispatch({ type: 'GO_TO', step: 4 });
                  }
                }}
              >
                Back
              </button>
            )}
            {state.step !== 7 && state.step !== 1 && (
              <button
                type="button"
                className="bw-btn"
                disabled={!ready}
                onClick={() => dispatch({ type: 'NEXT' })}
              >
                Continue
              </button>
            )}
            {state.step === 7 && state.status.kind !== 'submitting' && (
              <button
                type="button"
                className="bw-btn"
                onClick={submit}
              >
                Book the group
              </button>
            )}
            {state.step === 7 && state.status.kind === 'submitting' && (
              <button type="button" className="bw-btn" disabled>
                Booking…
              </button>
            )}
          </div>

          {state.status.kind === 'error' && (
            <div className="gw__error" role="alert">
              {state.status.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Step 1: Size ----------
function Step1Size({
  size,
  barberCount,
  onPick,
}: {
  size: 2 | 3 | 4;
  barberCount: number;
  onPick: (n: 2 | 3 | 4) => void;
}) {
  const options = resolveSizeOptions(barberCount);
  // The "lede" line tracks the live cap. When it's 4 the description
  // matches the original copy; when it's lower we add an honest aside
  // so the customer isn't left wondering why "Four people" is gone.
  const cap = options[options.length - 1] ?? 4;
  const lede =
    cap >= 4
      ? 'Pick a group size to get started. We support 2 to 4 people in a single group.'
      : `Pick a group size to get started. We support up to ${cap} per group — that's how many barbers we have on the floor.`;
  return (
    <div className="gw__step-body">
      <h2>How many people are booking together?</h2>
      <p className="gw__lede">{lede}</p>
      <div className="gw__size-grid">
        {options.map((n) => (
          <button
            key={n}
            type="button"
            className={`gw__size ${size === n ? 'is-active' : ''}`}
            onClick={() => onPick(n)}
          >
            <span className="gw__size-num">{n}</span>
            <span className="gw__size-label">
              {n === 2 ? 'Two people' : n === 3 ? 'Three people' : 'Four people'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- Step 2: Per-member service ----------
function Step2Services({
  members,
  services,
  onPick,
}: {
  members: Array<{ key: string; service: Service | null }>;
  services: Service[];
  onPick: (key: string, service: Service) => void;
}) {
  // We pick the SERVICE per member, not a single variation. Square
  // models per-barber-priced services as N variations (one per barber);
  // the matcher resolves which specific variation applies once a
  // barber is paired with the member at slot-pick time.
  return (
    <div className="gw__step-body">
      <h2>What service for each person?</h2>
      <p className="gw__lede">
        Each person can pick their own — or you can pick the same service for everyone.
      </p>
      <div className="gw__member-list">
        {members.map((m, idx) => (
          <fieldset key={m.key} className="gw__member-row">
            <legend className="gw__member-legend">Person {idx + 1}</legend>
            <div className="gw__service-grid">
              {services.map((svc) => {
                const bookable = svc.variations.filter((vv) => vv.availableForBooking);
                if (bookable.length === 0) return null;
                const active = m.service?.id === svc.id;
                // Range-aware price + duration: per-barber pricing means
                // the same service has different durations / prices per
                // variation. Show the typical (min) values.
                const minDuration = Math.min(...bookable.map((v) => v.durationMinutes));
                const prices = bookable
                  .map((v) => v.priceCents)
                  .filter((p): p is number => p !== null);
                const minPriceLabel =
                  prices.length > 0
                    ? `$${(Math.min(...prices) / 100).toFixed(0)}`
                    : 'Set at appointment';
                return (
                  <button
                    key={svc.id}
                    type="button"
                    className={`gw__service-card ${active ? 'is-active' : ''}`}
                    onClick={() => onPick(m.key, svc)}
                  >
                    <span className="gw__service-name">{svc.name}</span>
                    <span className="gw__service-meta">
                      {minDuration} min · {minPriceLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

// ---------- Step 3: Mode ----------
function Step3Mode({
  members,
  onPick,
}: {
  members: Array<{ key: string; service: Service | null }>;
  onPick: (mode: GroupMode) => void;
}) {
  // Per-barber-priced services have variations with different durations.
  // Use the median variation's duration as a "typical" for the rough
  // total — the precise duration depends on the resolved barber and
  // surfaces accurately on the confirm screen once a slot is picked.
  function typicalDuration(s: Service | null): number {
    if (!s) return 0;
    const ds = s.variations.map((v) => v.durationMinutes).sort((a, b) => a - b);
    return ds[Math.floor(ds.length / 2)] ?? 0;
  }
  const totalDuration = members.reduce(
    (sum, m) => sum + typicalDuration(m.service),
    0,
  );
  const longestDuration = Math.max(
    0,
    ...members.map((m) => typicalDuration(m.service)),
  );
  return (
    <div className="gw__step-body">
      <h2>How do you want to schedule it?</h2>
      <div className="gw__mode-grid">
        <button
          type="button"
          className="gw__mode-card"
          onClick={() => onPick('all-at-once')}
        >
          <span className="gw__mode-eyebrow">All at once</span>
          <span className="gw__mode-title">Different barbers, same time</span>
          <p className="gw__mode-desc">
            Everyone starts together with a different barber. Whoever has a shorter
            service finishes earlier and waits in the lobby. Total time:{' '}
            <strong>{longestDuration} min</strong>.
          </p>
        </button>
        <button
          type="button"
          className="gw__mode-card"
          onClick={() => onPick('back-to-back')}
        >
          <span className="gw__mode-eyebrow">Back-to-back</span>
          <span className="gw__mode-title">One barber, sequential</span>
          <p className="gw__mode-desc">
            One barber works through the group in a row. You'll pick which barber
            on the next step. Total time: <strong>{totalDuration} min</strong>.
          </p>
        </button>
      </div>
    </div>
  );
}

// ---------- Step 4: Barber (back-to-back only) ----------
function Step4Barber({
  members,
  barbers,
  selected,
  onPick,
}: {
  members: Array<{ key: string; service: Service | null }>;
  barbers: Barber[];
  selected: Barber | null;
  onPick: (b: Barber) => void;
}) {
  // For each member, the union of barbers across every bookable
  // variation of their picked service. Per-barber-priced services
  // store one variation per barber, so the union recovers the full
  // roster (intersected with `availableForBooking`). Then intersect
  // across all members so a back-to-back barber covers everyone.
  const eligibleIds = members.reduce<Set<string> | null>((acc, m) => {
    if (!m.service) return acc;
    const memberIds = new Set<string>();
    for (const v of m.service.variations) {
      if (!v.availableForBooking) continue;
      for (const id of v.eligibleTeamMemberIds) memberIds.add(id);
    }
    if (acc === null) return memberIds;
    return new Set([...acc].filter((id) => memberIds.has(id)));
  }, null);
  const eligibleBarbers = barbers.filter(
    (b) => !eligibleIds || eligibleIds.has(b.id),
  );

  return (
    <div className="gw__step-body">
      <h2>Pick a barber for the back-to-back group.</h2>
      <p className="gw__lede">
        Only barbers who can do every service in this group are listed.
      </p>
      <div className="gw__barber-grid">
        {eligibleBarbers.length === 0 ? (
          <p className="gw__empty">
            No single barber covers every service in this group. Go back and try
            "all at once" instead.
          </p>
        ) : (
          eligibleBarbers.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`gw__barber-card ${selected?.id === b.id ? 'is-active' : ''}`}
              onClick={() => onPick(b)}
            >
              <span className="gw__barber-name">{b.displayName}</span>
              <span className="gw__barber-role">{b.role}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ---------- Step 5: Time picker (month-grid calendar) ----------
//
// Calendar built locally rather than reusing the single-flow Step3
// because that one is tightly coupled to single-booking state. We
// only need the visual shell (month nav + day grid) and the rule
// that days without matching slots are disabled — the slot list
// itself comes from the GroupSlot[] the API already filtered for
// joint feasibility.
const SHOP_TZ_LOCAL = 'America/New_York';
const TODAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ_LOCAL,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function todayKeyShop(): string {
  return TODAY_FMT.format(new Date());
}
function ymdKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
function firstWeekday(year: number, month: number): number {
  return new Date(`${ymdKey(year, month, 1)}T12:00:00Z`).getUTCDay();
}

function Step5Time({
  loading,
  error,
  slots,
  selected,
  onPick,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  slots: GroupSlot[];
  selected: GroupSlot | null;
  onPick: (slot: GroupSlot) => void;
  onRetry: () => void;
}) {
  const slotsByDate = useMemo(() => {
    const m = new Map<string, GroupSlot[]>();
    for (const s of slots) {
      const list = m.get(s.dateKey) ?? [];
      list.push(s);
      m.set(s.dateKey, list);
    }
    return m;
  }, [slots]);

  const validDates = useMemo(
    () => [...slotsByDate.keys()].sort(),
    [slotsByDate],
  );

  const todayKey = useMemo(() => todayKeyShop(), []);
  const initialMonth = useMemo(() => {
    const seed = validDates[0] ?? todayKey;
    const [y, m] = seed.split('-').map(Number);
    return { year: y, month: m };
  }, [validDates, todayKey]);
  const [view, setView] = useState(initialMonth);
  const [activeDate, setActiveDate] = useState<string | null>(
    validDates.length > 0 ? validDates[0] : null,
  );

  useEffect(() => {
    if (validDates.length === 0) {
      setActiveDate(null);
      return;
    }
    if (!activeDate || !validDates.includes(activeDate)) {
      setActiveDate(validDates[0]);
      const [y, m] = validDates[0].split('-').map(Number);
      setView({ year: y, month: m });
    }
  }, [validDates, activeDate]);

  // Bound month nav to the range of valid dates we got back: don't let
  // the customer scroll forever past everything bookable, or back into
  // months that are entirely in the past.
  const minMonth = (() => {
    const [y, m] = (validDates[0] ?? todayKey).split('-').map(Number);
    return { year: y, month: m };
  })();
  const maxMonth = (() => {
    const [y, m] = (validDates[validDates.length - 1] ?? todayKey)
      .split('-')
      .map(Number);
    return { year: y, month: m };
  })();
  const canPrev =
    view.year > minMonth.year ||
    (view.year === minMonth.year && view.month > minMonth.month);
  const canNext =
    view.year < maxMonth.year ||
    (view.year === maxMonth.year && view.month < maxMonth.month);
  function shiftMonth(delta: number) {
    setView((prev) => {
      const total = prev.year * 12 + (prev.month - 1) + delta;
      return { year: Math.floor(total / 12), month: (total % 12) + 1 };
    });
  }

  if (loading) {
    return (
      <div className="gw__step-body">
        <h2>Finding times that work for the whole group…</h2>
        <p className="gw__lede">
          Cross-checking each person's service against the calendar.
        </p>
        <div className="gw__loading">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="gw__step-body">
        <h2>Couldn't load openings</h2>
        <p className="gw__error">{error}</p>
        <button type="button" className="bw-btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (slots.length === 0) {
    return (
      <div className="gw__step-body">
        <h2>No matching openings in the next 60 days.</h2>
        <p className="gw__lede">
          Try a different schedule mode or split the group across separate
          bookings. You can also call us at{' '}
          <a className="link-gold" href="tel:+17402974462">740-297-4462</a>.
        </p>
      </div>
    );
  }

  const totalDays = daysInMonth(view.year, view.month);
  const leadingBlanks = firstWeekday(view.year, view.month);
  const activeSlots = activeDate ? (slotsByDate.get(activeDate) ?? []) : [];

  return (
    <div className="gw__step-body">
      <h2>Pick a time</h2>
      <div className="bw-cal">
        <div className="bw-cal-head">
          <button
            type="button"
            className="bw-cal-nav"
            onClick={() => shiftMonth(-1)}
            disabled={!canPrev}
            aria-label="Previous month"
          >‹</button>
          <div className="bw-cal-title" aria-live="polite">
            {MONTH_LABELS[view.month - 1]} {view.year}
          </div>
          <button
            type="button"
            className="bw-cal-nav"
            onClick={() => shiftMonth(1)}
            disabled={!canNext}
            aria-label="Next month"
          >›</button>
        </div>

        <div className="bw-cal-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
        </div>

        <div
          className="bw-cal-grid"
          role="grid"
          aria-label={`${MONTH_LABELS[view.month - 1]} ${view.year}`}
        >
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <span key={`blank-${i}`} className="bw-cal-blank" />
          ))}
          {Array.from({ length: totalDays }, (_, i) => {
            const day = i + 1;
            const dateKey = ymdKey(view.year, view.month, day);
            const isPast = dateKey < todayKey;
            const hasSlots = slotsByDate.has(dateKey);
            const disabled = isPast || !hasSlots;
            const isActive = dateKey === activeDate;
            // The shared .bw-cal-day CSS targets data-has-slots +
            // data-selected attributes (not class names) — match the
            // single-flow calendar's contract so clickable days
            // actually look clickable and the picked day fills gold.
            return (
              <button
                key={dateKey}
                type="button"
                className="bw-cal-day"
                data-has-slots={hasSlots ? 'true' : undefined}
                data-selected={isActive ? 'true' : undefined}
                disabled={disabled}
                aria-pressed={isActive}
                onClick={() => setActiveDate(dateKey)}
                title={
                  isPast
                    ? 'In the past'
                    : !hasSlots
                      ? 'No openings'
                      : `${slotsByDate.get(dateKey)?.length ?? 0} times`
                }
              >
                <span className="bw-cal-day-num">{day}</span>
                {hasSlots && <span className="bw-cal-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>

      {activeDate && activeSlots.length > 0 && (
        <div className="gw__slot-grid">
          {activeSlots.map((slot) => (
            <button
              key={slot.startAtUtc + (slot.mode === 'back-to-back' ? '-btb' : '-aao')}
              type="button"
              className={`gw__slot ${selected?.startAtUtc === slot.startAtUtc ? 'is-active' : ''}`}
              onClick={() => onPick(slot)}
            >
              {formatTime(slot.startAtUtc)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Step 6: Details ----------
function Step6Details({
  parent,
  members,
  groupNote,
  savedPeople,
  onParent,
  onMemberName,
  onMemberWho,
  onGroupNote,
}: {
  parent: { givenName: string; familyName: string; email: string; phone: string };
  members: Array<{
    key: string;
    displayName: string;
    who: 'self' | 'existing' | 'new';
    existingCustomerId?: string;
  }>;
  groupNote: string;
  savedPeople: BookingForOption[];
  onParent: (patch: Partial<typeof parent>) => void;
  onMemberName: (key: string, name: string) => void;
  onMemberWho: (payload: {
    key: string;
    who: 'self' | 'existing' | 'new';
    existingCustomerId?: string;
    displayName?: string;
  }) => void;
  onGroupNote: (note: string) => void;
}) {
  // The picker only adds value when the parent has saved people. With
  // length 1 (just self) we still let them tap "Me", but we hide the
  // dropdown entirely if they aren't signed in (length 0). Plain
  // text inputs are the fallback in that case.
  const hasOptions = savedPeople.length > 0;
  return (
    <div className="gw__step-body">
      <h2>Your details + each person</h2>
      <p className="gw__lede">
        Parent contact for confirmations. Pick saved people from your profile, or
        type a new name — we'll add new names to your profile so they're one tap
        away next time.
      </p>
      <fieldset className="gw__field-block">
        <legend>Parent / point of contact</legend>
        <div className="gw__field-row">
          <label className="bw-field">
            <span className="bw-field__label">First name</span>
            <input
              type="text"
              autoComplete="given-name"
              value={parent.givenName}
              onChange={(e) => onParent({ givenName: e.target.value })}
            />
          </label>
          <label className="bw-field">
            <span className="bw-field__label">Last name</span>
            <input
              type="text"
              autoComplete="family-name"
              value={parent.familyName}
              onChange={(e) => onParent({ familyName: e.target.value })}
            />
          </label>
        </div>
        <div className="gw__field-row">
          <label className="bw-field">
            <span className="bw-field__label">Email</span>
            <input
              type="email"
              autoComplete="email"
              value={parent.email}
              onChange={(e) => onParent({ email: e.target.value })}
            />
          </label>
          <label className="bw-field">
            <span className="bw-field__label">Phone</span>
            <input
              type="tel"
              autoComplete="tel"
              value={parent.phone}
              onChange={(e) => onParent({ phone: e.target.value })}
            />
          </label>
        </div>
      </fieldset>
      <fieldset className="gw__field-block">
        <legend>Who's getting cut</legend>
        {members.map((m, idx) => (
          <div key={m.key} className="gw__person-row">
            <span className="gw__person-num">Person {idx + 1}</span>
            {hasOptions && (
              <div className="gw__person-picker">
                {savedPeople.map((p) => {
                  const active =
                    (p.isSelf && m.who === 'self') ||
                    (!p.isSelf && m.who === 'existing' && m.existingCustomerId === p.customerId);
                  return (
                    <button
                      key={p.customerId}
                      type="button"
                      className={`gw__person-chip ${active ? 'is-active' : ''}`}
                      onClick={() =>
                        onMemberWho({
                          key: m.key,
                          who: p.isSelf ? 'self' : 'existing',
                          existingCustomerId: p.isSelf ? undefined : p.customerId,
                          displayName: p.displayName,
                        })
                      }
                    >
                      {p.displayName}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`gw__person-chip ${m.who === 'new' ? 'is-active' : ''}`}
                  onClick={() =>
                    onMemberWho({ key: m.key, who: 'new', displayName: '' })
                  }
                >
                  + New person
                </button>
              </div>
            )}
            {(!hasOptions || m.who === 'new') && (
              <label className="bw-field gw__person-name">
                <span className="bw-field__label">Name</span>
                <input
                  type="text"
                  placeholder={idx === 0 ? 'e.g. Tommy' : 'Name'}
                  value={m.displayName}
                  onChange={(e) => onMemberName(m.key, e.target.value)}
                />
              </label>
            )}
          </div>
        ))}
      </fieldset>
      <label className="bw-field">
        <span className="bw-field__label">Anything we should know? (optional)</span>
        <textarea
          rows={3}
          value={groupNote}
          onChange={(e) => onGroupNote(e.target.value)}
          placeholder="e.g. Youngest is nervous about clippers."
        />
      </label>
    </div>
  );
}

// ---------- Step 7: Confirm ----------
function Step7Confirm({
  state,
  onConfirm: _onConfirm,
}: {
  state: ReturnType<typeof useReducer>[0] extends infer S ? S : never;
  onConfirm: () => void;
}) {
  const s = state as {
    members: Array<{ key: string; displayName: string; service: Service | null }>;
    selectedSlot: GroupSlot | null;
    selectedBarber: Barber | null;
    parent: { givenName: string; familyName: string; email: string; phone: string };
    groupNote: string;
    mode: GroupMode | null;
  };
  if (!s.selectedSlot) return null;
  const slot = s.selectedSlot;
  return (
    <div className="gw__step-body">
      <h2>Confirm the group booking</h2>
      <div className="gw__confirm">
        <p className="gw__confirm-when">
          <strong>{formatLong(slot.startAtUtc)}</strong>
          {' · '}
          {slot.mode === 'all-at-once' ? 'All at once' : 'Back-to-back'}
        </p>
        <ul className="gw__confirm-list">
          {s.members.map((m, i) => {
            const seg =
              slot.mode === 'all-at-once'
                ? slot.assignments[i]
                : slot.segments[i];
            const teamMemberId =
              slot.mode === 'all-at-once'
                ? slot.assignments[i].teamMemberId
                : slot.teamMemberId;
            const startAtUtc =
              slot.mode === 'all-at-once' ? slot.startAtUtc : slot.segments[i].startAtUtc;
            return (
              <li key={m.key} className="gw__confirm-row">
                <strong>{m.displayName || `Person ${i + 1}`}</strong> ·{' '}
                {m.service?.name ?? 'Service'} · {seg.durationMinutes} min
                <br />
                <span className="gw__confirm-sub">
                  {formatTime(startAtUtc)} · barber: {teamMemberId.slice(-4)}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="gw__confirm-meta">
          Parent: <strong>{s.parent.givenName} {s.parent.familyName}</strong> ·{' '}
          {s.parent.email} · {s.parent.phone}
        </p>
        {s.groupNote && (
          <p className="gw__confirm-note">"{s.groupNote}"</p>
        )}
      </div>
      <p className="gw__policy">
        We'll create one booking per person, all linked under your account so the shop sees you as a group. No deposit on group bookings.
      </p>
    </div>
  );
}

// ---------- Success ----------
function SuccessScreen({
  state,
  onReset,
}: {
  state: ReturnType<typeof useReducer>[0] extends infer S ? S : never;
  onReset: () => void;
}) {
  const s = state as {
    status: { kind: 'success'; groupId: string; bookings: Array<{ memberKey: string; bookingId: string | null }>; failures: Array<{ memberKey: string; displayName: string; code: string; detail: string; slotTaken: boolean }> };
    members: Array<{ key: string; displayName: string }>;
  };
  const success = s.status;
  const succeeded = success.bookings.filter((b) => b.bookingId !== null);
  const failed = success.failures;

  return (
    <div className="gw__success">
      {failed.length === 0 ? (
        <>
          <div className="gw__success-icon" aria-hidden="true">✓</div>
          <h2>The group is booked.</h2>
          <p>
            We've sent a confirmation to your email. Group ref: <strong>{success.groupId}</strong>.
          </p>
        </>
      ) : (
        <>
          <h2>{succeeded.length} of {success.bookings.length} booked.</h2>
          <p>
            One or more bookings couldn't be completed (most likely the slot was just taken).
            Please call us at <a className="link-gold" href="tel:+17402974462">740-297-4462</a> to finish.
          </p>
          <ul className="gw__success-failures">
            {failed.map((f) => (
              <li key={f.memberKey}>
                <strong>{f.displayName || 'Person'}</strong> — {f.detail}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="gw__success-actions">
        <a className="bw-btn bw-btn--ghost" href="/my-bookings">
          View My Bookings
        </a>
        <button type="button" className="bw-btn" onClick={onReset}>
          Book another group
        </button>
      </div>
    </div>
  );
}

// ---------- Helpers ----------
function buildAssignments(
  members: Array<{ key: string; displayName: string; service: Service | null }>,
  slot: GroupSlot,
) {
  if (slot.mode === 'all-at-once') {
    return members.map((m) => {
      const a = slot.assignments.find((x) => x.memberKey === m.key)!;
      return {
        key: m.key,
        displayName: m.displayName,
        serviceVariationId: a.serviceVariationId,
        teamMemberId: a.teamMemberId,
        durationMinutes: a.durationMinutes,
        startAtUtc: slot.startAtUtc,
      };
    });
  }
  return members.map((m, i) => {
    const seg = slot.segments[i];
    return {
      key: m.key,
      displayName: m.displayName,
      serviceVariationId: seg.serviceVariationId,
      teamMemberId: slot.teamMemberId,
      durationMinutes: seg.durationMinutes,
      startAtUtc: seg.startAtUtc,
    };
  });
}

const longFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
function formatLong(utc: string): string {
  return longFmt.format(new Date(utc));
}
function formatTime(utc: string): string {
  return timeFmt.format(new Date(utc));
}
