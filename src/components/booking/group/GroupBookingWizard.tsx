import { useEffect, useMemo, useReducer, useState } from 'react';
import type { Barber, Service, ServiceVariation } from '../../../lib/square/types';
import type { GroupSlot } from '../../../lib/booking/groupAvailability';
import {
  canAdvance,
  makeInitialState,
  reducer,
  type GroupMode,
} from './groupWizardState';

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

const sizeOptions: Array<2 | 3 | 4> = [2, 3, 4];

export default function GroupBookingWizard({
  services,
  barbers,
  signedInCustomer,
}: Props) {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    makeInitialState(2),
  );

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
        serviceVariationId: m.variation!.id,
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
    const assignments = buildAssignments(state.members, state.selectedSlot);
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
    <div className="gw">
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
              onPick={(key, service, variation) =>
                dispatch({ type: 'SET_MEMBER_SERVICE', key, service, variation })
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
              onParent={(patch) => dispatch({ type: 'SET_PARENT', patch })}
              onMemberName={(key, name) =>
                dispatch({ type: 'SET_MEMBER_NAME', key, name })
              }
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
  onPick,
}: {
  size: 2 | 3 | 4;
  onPick: (n: 2 | 3 | 4) => void;
}) {
  return (
    <div className="gw__step-body">
      <h2>How many people are booking together?</h2>
      <p className="gw__lede">
        Pick a group size to get started. We support 2 to 4 people in a single group.
      </p>
      <div className="gw__size-grid">
        {sizeOptions.map((n) => (
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
  members: ReturnType<typeof useReducer>[0] extends infer S
    ? S extends { members: infer M }
      ? M
      : never
    : never;
  services: Service[];
  onPick: (key: string, service: Service, variation: ServiceVariation) => void;
}) {
  // The wizard is intentionally single-variation per member. For
  // services with multiple variations we show the primary (first) so
  // the picker stays simple — the existing single-flow already covers
  // edge cases like beard add-ons and longer haircuts.
  return (
    <div className="gw__step-body">
      <h2>What service for each person?</h2>
      <p className="gw__lede">
        Each person can pick their own — or you can pick the same service for everyone.
      </p>
      <div className="gw__member-list">
        {(members as Array<{ key: string; service: Service | null; variation: ServiceVariation | null }>).map(
          (m, idx) => (
            <fieldset key={m.key} className="gw__member-row">
              <legend className="gw__member-legend">Person {idx + 1}</legend>
              <div className="gw__service-grid">
                {services.map((svc) => {
                  const variation = svc.variations[0];
                  if (!variation || !variation.availableForBooking) return null;
                  const active = m.variation?.id === variation.id;
                  const price =
                    variation.priceCents !== null
                      ? `$${(variation.priceCents / 100).toFixed(0)}`
                      : 'Set at appointment';
                  return (
                    <button
                      key={svc.id}
                      type="button"
                      className={`gw__service-card ${active ? 'is-active' : ''}`}
                      onClick={() => onPick(m.key, svc, variation)}
                    >
                      <span className="gw__service-name">{svc.name}</span>
                      <span className="gw__service-meta">
                        {variation.durationMinutes} min · {price}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ),
        )}
      </div>
    </div>
  );
}

// ---------- Step 3: Mode ----------
function Step3Mode({
  members,
  onPick,
}: {
  members: Array<{ key: string; variation: ServiceVariation | null }>;
  onPick: (mode: GroupMode) => void;
}) {
  const totalDuration = members.reduce(
    (sum, m) => sum + (m.variation?.durationMinutes ?? 0),
    0,
  );
  const longestDuration = Math.max(
    0,
    ...members.map((m) => m.variation?.durationMinutes ?? 0),
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
  members: Array<{ key: string; variation: ServiceVariation | null }>;
  barbers: Barber[];
  selected: Barber | null;
  onPick: (b: Barber) => void;
}) {
  // Only barbers eligible for every member's service can take a
  // back-to-back group — filter so we don't show options that would
  // certainly fail availability.
  const eligibleIds = members.reduce<Set<string> | null>((acc, m) => {
    if (!m.variation) return acc;
    const ids = new Set(m.variation.eligibleTeamMemberIds);
    if (acc === null) return ids;
    return new Set([...acc].filter((id) => ids.has(id)));
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

// ---------- Step 5: Time picker ----------
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
  const dates = useMemo(() => [...slotsByDate.keys()].sort(), [slotsByDate]);
  const [activeDate, setActiveDate] = useState<string | null>(
    dates.length > 0 ? dates[0] : null,
  );
  // Sync activeDate when slots refresh.
  useEffect(() => {
    if (dates.length === 0) {
      setActiveDate(null);
      return;
    }
    if (!activeDate || !dates.includes(activeDate)) {
      setActiveDate(dates[0]);
    }
  }, [dates, activeDate]);

  if (loading) {
    return (
      <div className="gw__step-body">
        <h2>Finding times that work for the whole group…</h2>
        <p className="gw__lede">Cross-checking each person's service against the calendar.</p>
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
        <h2>No matching openings in the next 30 days.</h2>
        <p className="gw__lede">
          Try a different schedule mode or split the group across separate
          bookings. You can also call us at <a className="link-gold" href="tel:+17402974462">740-297-4462</a>.
        </p>
      </div>
    );
  }

  const activeSlots = activeDate ? (slotsByDate.get(activeDate) ?? []) : [];
  return (
    <div className="gw__step-body">
      <h2>Pick a time</h2>
      <div className="gw__date-strip">
        {dates.map((d) => (
          <button
            key={d}
            type="button"
            className={`gw__date-chip ${activeDate === d ? 'is-active' : ''}`}
            onClick={() => setActiveDate(d)}
          >
            {formatDateChip(d)}
          </button>
        ))}
      </div>
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
    </div>
  );
}

// ---------- Step 6: Details ----------
function Step6Details({
  parent,
  members,
  groupNote,
  onParent,
  onMemberName,
  onGroupNote,
}: {
  parent: { givenName: string; familyName: string; email: string; phone: string };
  members: Array<{ key: string; displayName: string }>;
  groupNote: string;
  onParent: (patch: Partial<typeof parent>) => void;
  onMemberName: (key: string, name: string) => void;
  onGroupNote: (note: string) => void;
}) {
  return (
    <div className="gw__step-body">
      <h2>Your details + a name for each person</h2>
      <p className="gw__lede">
        We'll use the parent's contact info for confirmations. Each person's name
        goes on their booking so the shop knows who's who.
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
        <legend>Names for each person</legend>
        {members.map((m, idx) => (
          <label key={m.key} className="bw-field">
            <span className="bw-field__label">Person {idx + 1}</span>
            <input
              type="text"
              placeholder={idx === 0 ? 'e.g. Tommy' : 'Name'}
              value={m.displayName}
              onChange={(e) => onMemberName(m.key, e.target.value)}
            />
          </label>
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
    members: Array<{ key: string; displayName: string; service: Service | null; variation: ServiceVariation | null }>;
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
  members: Array<{ key: string; displayName: string; variation: ServiceVariation | null }>,
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
const dateChipFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
function formatLong(utc: string): string {
  return longFmt.format(new Date(utc));
}
function formatTime(utc: string): string {
  return timeFmt.format(new Date(utc));
}
function formatDateChip(dateKey: string): string {
  // dateKey is YYYY-MM-DD in shop tz; render as the local-noon to dodge
  // timezone edge cases for the chip label.
  return dateChipFmt.format(new Date(`${dateKey}T12:00:00`));
}
