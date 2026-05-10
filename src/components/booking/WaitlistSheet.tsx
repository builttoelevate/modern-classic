import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  serviceName: string;
  barberName: string;
  /** Square IDs — passed through to the admin so 'Schedule' can deep-link. */
  serviceVariationId?: string | null;
  teamMemberId?: string | null;
  /** Pre-fill these if we already collected them in Step 4. */
  prefillName?: string;
  prefillEmail?: string;
  prefillPhone?: string;
  /** When the caller can't pre-pick a barber for the customer (e.g. the
   * hero trigger fires before any booking-flow choice has been made),
   * pass the active roster here and the sheet renders a dropdown
   * defaulting to "Any barber". When omitted, the sheet uses the
   * `barberName` prop as fixed display text — the existing behavior
   * for the in-flow Step 3 trigger that already knows the barber. */
  barberOptions?: Array<{ id: string; displayName: string }>;
  /** Same idea as `barberOptions` but for services. The hero trigger
   * fires before the customer has picked a service, so without this the
   * entry would land in KV with no `serviceVariationId` and the hourly
   * cron would skip it as `noVariation` (never auto-emailing). When
   * provided, the sheet renders a required <select> and uses the picked
   * option's id/name in place of the `serviceName` / `serviceVariationId`
   * props. `id` is the bookable serviceVariationId. */
  serviceOptions?: Array<{ id: string; name: string }>;
}

interface WaitlistApiResponse {
  ok: boolean;
  error?: { code: string; detail: string };
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
type TimeKey = 'morning' | 'afternoon' | 'evening';

const DAY_OPTIONS: Array<{ key: DayKey; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
];

const TIME_OPTIONS: Array<{ key: TimeKey; label: string; sub: string }> = [
  { key: 'morning', label: 'Morning', sub: 'before 12pm' },
  { key: 'afternoon', label: 'Afternoon', sub: '12 – 3pm' },
  { key: 'evening', label: 'Evening', sub: '3pm +' },
];

/** YYYY-MM-DD for `date` in shop-tz (America/New_York). Used for default
 * date-range values. en-CA locale conveniently produces the ISO format. */
function shopDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function WaitlistSheet({
  open,
  onClose,
  serviceName,
  barberName,
  serviceVariationId = null,
  teamMemberId = null,
  prefillName = '',
  prefillEmail = '',
  prefillPhone = '',
  barberOptions,
  serviceOptions,
}: Props) {
  const [name, setName] = useState(prefillName);
  const [email, setEmail] = useState(prefillEmail);
  const [phone, setPhone] = useState(prefillPhone);
  // Service selection. When `serviceOptions` is provided, the picker
  // drives `effectiveServiceVariationId` / `effectiveServiceName` below;
  // otherwise we use the props (in-flow Step 3 trigger path).
  const [pickedServiceId, setPickedServiceId] = useState<string>('');
  // Multi-pick barber selection. Customers can opt in to multiple barbers
  // so they get notified the moment ANY of them has an opening. Empty
  // array = "any barber works." Pre-checks the wizard-level barber when
  // we know it (Step 3 in-flow); otherwise starts empty.
  const [pickedBarberIds, setPickedBarberIds] = useState<string[]>(() =>
    teamMemberId ? [teamMemberId] : [],
  );
  // Default the date range to "today through 30 days out" — covers
  // most customers' realistic flexibility window.
  const [dateFrom, setDateFrom] = useState(() => shopDateKey(new Date()));
  const [dateTo, setDateTo] = useState(() => {
    const t = new Date();
    t.setDate(t.getDate() + 30);
    return shopDateKey(t);
  });
  // All chips on by default = "any day / any time works." Customer can
  // toggle off to narrow.
  const [daysOfWeek, setDaysOfWeek] = useState<DayKey[]>([
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
  ]);
  const [timesOfDay, setTimesOfDay] = useState<TimeKey[]>([
    'morning',
    'afternoon',
    'evening',
  ]);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Which weekdays the picked [dateFrom, dateTo] range actually covers.
  // Drives both the "hide chip row when no narrowing is possible" branch
  // and the per-chip disabled state — chips for weekdays outside the
  // range can only ever match an empty set of slots, so making them
  // tappable just confuses the customer (they think they're narrowing
  // when they're really creating an impossible filter).
  const weekdaysInRange = useMemo(() => {
    const set = new Set<DayKey>();
    if (!dateFrom || !dateTo) return set;
    const fromMs = Date.parse(`${dateFrom}T12:00:00`);
    const toMs = Date.parse(`${dateTo}T12:00:00`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) return set;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const MAX_ITERS = 60; // safety net; real ranges are < 12 months
    for (let ms = fromMs, i = 0; ms <= toMs && i < MAX_ITERS; ms += DAY_MS, i++) {
      const dow = new Date(ms).getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      if (dow === 0) continue; // Sunday — shop closed; not a chip option
      set.add(DAY_OPTIONS[dow - 1].key);
    }
    return set;
  }, [dateFrom, dateTo]);
  // When the range covers at most one bookable weekday, the chip row
  // can only re-state the date range. Hide it; show a small reassurance
  // line so the customer knows their day-of-week preference (if any
  // was set on a wider range earlier) hasn't been silently lost.
  const showDayChips = weekdaysInRange.size > 1;

  function toggleDay(key: DayKey) {
    setDaysOfWeek((prev) =>
      prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key],
    );
  }
  function toggleTime(key: TimeKey) {
    setTimesOfDay((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key],
    );
  }
  function toggleBarber(id: string) {
    setPickedBarberIds((prev) =>
      prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id],
    );
  }

  // Sync prefill values back in if they change while the sheet was closed.
  useEffect(() => {
    if (open) {
      setName((current) => current || prefillName);
      setEmail((current) => current || prefillEmail);
      setPhone((current) => current || prefillPhone);
      setStatus('idle');
      setErrorMsg(null);
      // Focus first empty field when opening.
      requestAnimationFrame(() => firstFieldRef.current?.focus());
    }
  }, [open, prefillName, prefillEmail, prefillPhone]);

  // Esc-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while the sheet is open so the page behind doesn't
  // tug-of-war with the form on iOS Safari, which is what made the sheet
  // appear off-screen before — the page kept its scroll position and the
  // sheet (rendered via portal) lived above it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  // The service select renders whenever a non-empty roster is supplied
  // (hero path). When omitted (in-flow Step 3 path), the props
  // serviceName / serviceVariationId already describe a concrete service
  // the customer just looked at, so no picker is needed.
  const showServicePicker = Array.isArray(serviceOptions) && serviceOptions.length > 0;
  const pickedService = showServicePicker
    ? (serviceOptions ?? []).find((s) => s.id === pickedServiceId) ?? null
    : null;
  const effectiveServiceName = showServicePicker
    ? pickedService?.name ?? serviceName
    : serviceName;
  const effectiveServiceVariationId = showServicePicker
    ? pickedService?.id ?? null
    : serviceVariationId;

  // The multi-pick barber chips render whenever a roster is supplied.
  // Empty selection = "any barber works." When exactly one barber is
  // picked, the email + admin record show that barber's name; multi-pick
  // shows a friendly "Michael, Rick, or Clayton" phrase.
  const showBarberPicker = Array.isArray(barberOptions) && barberOptions.length > 0;
  const pickedBarbers = showBarberPicker
    ? (barberOptions ?? []).filter((b) => pickedBarberIds.includes(b.id))
    : [];
  function joinNames(names: string[]): string {
    if (names.length === 0) return 'Any barber';
    if (names.length === 1) return names[0]!;
    if (names.length === 2) return `${names[0]} or ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
  }
  const effectiveBarberName = showBarberPicker
    ? joinNames(pickedBarbers.map((b) => b.displayName))
    : barberName;
  const effectiveTeamMemberId =
    pickedBarbers[0]?.id ?? (showBarberPicker ? null : teamMemberId ?? null);
  const effectiveTeamMemberIds = showBarberPicker
    ? pickedBarbers.map((b) => b.id)
    : teamMemberId
      ? [teamMemberId]
      : [];
  const effectiveBarberDisplayNames = showBarberPicker
    ? pickedBarbers.map((b) => b.displayName)
    : teamMemberId
      ? [barberName]
      : [];

  // The hero-level trigger doesn't have a concrete service/barber yet —
  // we pass "Any service" / "Any barber" sentinels through so the admin
  // email + KV record still capture the customer's flexibility, but the
  // user-facing copy reads naturally instead of "a Any service opening
  // with Any barber matches".
  const isFlexibleBarber = /^any\b/i.test(effectiveBarberName);
  const isFlexibleService = /^any\b/i.test(effectiveServiceName);
  const matchPhrase = (() => {
    if (isFlexibleBarber && isFlexibleService) return 'an opening that fits';
    if (isFlexibleBarber) return (
      <>a <strong>{effectiveServiceName}</strong> opening</>
    );
    if (isFlexibleService) return (
      <>an opening with <strong>{effectiveBarberName}</strong></>
    );
    return (
      <>a <strong>{effectiveServiceName}</strong> opening with <strong>{effectiveBarberName}</strong></>
    );
  })();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'submitting') return;
    // When the service picker is shown, the customer must pick one — without
    // it the cron has no `serviceVariationId` to query Square against and
    // skips the entry as `noVariation`, which would silently break the
    // "we'll email you the moment a spot opens" promise.
    if (showServicePicker && !pickedServiceId) {
      setStatus('error');
      setErrorMsg('Please pick a service.');
      return;
    }
    setStatus('submitting');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          serviceName: effectiveServiceName,
          barberName: effectiveBarberName,
          serviceVariationId: effectiveServiceVariationId,
          teamMemberId: effectiveTeamMemberId,
          teamMemberIds: effectiveTeamMemberIds,
          barberDisplayNames: effectiveBarberDisplayNames,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          daysOfWeek,
          timesOfDay,
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json()) as WaitlistApiResponse;
      if (data.ok) {
        setStatus('success');
        return;
      }
      setStatus('error');
      setErrorMsg(data.error?.detail || 'Could not submit. Please try again.');
    } catch {
      setStatus('error');
      setErrorMsg('Network error. Please try again.');
    }
  };

  return createPortal(
    <div className="bw-waitlist" role="dialog" aria-modal="true" aria-labelledby="bw-waitlist-title">
      <button
        type="button"
        className="bw-waitlist__scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="bw-waitlist__panel">
        <header className="bw-waitlist__head">
          <h2 id="bw-waitlist-title">Join the waitlist</h2>
          <button
            type="button"
            className="bw-waitlist__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {status === 'success' ? (
          <div className="bw-waitlist__success">
            <p>
              <strong>You're on the list.</strong>
            </p>
            <p>
              We'll email you the moment {matchPhrase} shows up that matches
              the dates and times you picked. Questions? Call{' '}
              <a className="link-gold" href="tel:+17402974462">740-297-4462</a>.
            </p>
            <div className="bw-waitlist__actions">
              <button type="button" className="bw-btn" onClick={onClose}>
                Got it
              </button>
            </div>
          </div>
        ) : (
          <form className="bw-waitlist__form" onSubmit={submit} noValidate>
            <p className="bw-waitlist__sub">
              Tell us how to reach you and when you're available — we'll email
              you automatically the moment {matchPhrase} matches.
            </p>

            <label className="bw-field">
              <span className="bw-field__label">Name</span>
              <input
                ref={firstFieldRef}
                type="text"
                autoComplete="name"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <div className="bw-field-row">
              <label className="bw-field">
                <span className="bw-field__label">Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={120}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="bw-field">
                <span className="bw-field__label">Phone</span>
                <input
                  type="tel"
                  autoComplete="tel"
                  required
                  maxLength={32}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </label>
            </div>

            {showServicePicker && (
              <label className="bw-field">
                <span className="bw-field__label">Service</span>
                <select
                  className="bw-field__select"
                  required
                  value={pickedServiceId}
                  onChange={(e) => setPickedServiceId(e.target.value)}
                >
                  <option value="" disabled>
                    Pick a service…
                  </option>
                  {(serviceOptions ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {showBarberPicker && (
              <div className="bw-field">
                <span className="bw-field__label">
                  Notify me about{' '}
                  <span className="bw-field__optional">
                    (pick one or more — leave all off for any barber)
                  </span>
                </span>
                <div
                  className="bw-chip-row bw-chip-row--barbers"
                  role="group"
                  aria-label="Barbers to be notified about"
                >
                  {(barberOptions ?? []).map((b) => {
                    const active = pickedBarberIds.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`bw-chip${active ? ' bw-chip--on' : ''}`}
                        aria-pressed={active}
                        onClick={() => toggleBarber(b.id)}
                      >
                        {b.displayName}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="bw-waitlist__prefs">
              <p className="bw-waitlist__prefs-help">
                Tell us when you're available. We'll <strong>email you the moment
                a slot opens</strong> that matches.
              </p>

              <div className="bw-field-row">
                <label className="bw-field">
                  <span className="bw-field__label">From</span>
                  <input
                    type="date"
                    value={dateFrom}
                    min={shopDateKey(new Date())}
                    onChange={(e) => setDateFrom(e.target.value)}
                  />
                </label>
                <label className="bw-field">
                  <span className="bw-field__label">To</span>
                  <input
                    type="date"
                    value={dateTo}
                    min={dateFrom || shopDateKey(new Date())}
                    onChange={(e) => setDateTo(e.target.value)}
                  />
                </label>
              </div>

              {showDayChips ? (
                <div className="bw-field">
                  <span className="bw-field__label">
                    Days that work <span className="bw-field__optional">(tap to toggle)</span>
                  </span>
                  <div className="bw-chip-row" role="group" aria-label="Days of week">
                    {DAY_OPTIONS.map((opt) => {
                      const active = daysOfWeek.includes(opt.key);
                      const inRange = weekdaysInRange.has(opt.key);
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          className={`bw-chip${active && inRange ? ' bw-chip--on' : ''}`}
                          aria-pressed={active && inRange}
                          disabled={!inRange}
                          onClick={() => toggleDay(opt.key)}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="bw-field bw-field--hint">
                  Days are set by the dates above.
                </p>
              )}

              <div className="bw-field">
                <span className="bw-field__label">
                  Times that work <span className="bw-field__optional">(tap to toggle)</span>
                </span>
                <div className="bw-chip-row" role="group" aria-label="Times of day">
                  {TIME_OPTIONS.map((opt) => {
                    const active = timesOfDay.includes(opt.key);
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        className={`bw-chip bw-chip--wide${active ? ' bw-chip--on' : ''}`}
                        aria-pressed={active}
                        onClick={() => toggleTime(opt.key)}
                      >
                        <span className="bw-chip__label">{opt.label}</span>
                        <span className="bw-chip__sub">{opt.sub}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <label className="bw-field">
              <span className="bw-field__label">
                Anything else? <span className="bw-field__optional">(optional)</span>
              </span>
              <textarea
                rows={3}
                maxLength={600}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            {errorMsg && (
              <p className="bw-waitlist__error" role="alert">
                {errorMsg}
              </p>
            )}

            <div className="bw-waitlist__actions">
              <button
                type="button"
                className="bw-btn bw-btn--ghost"
                onClick={onClose}
                disabled={status === 'submitting'}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="bw-btn"
                disabled={status === 'submitting'}
              >
                {status === 'submitting' ? 'Sending…' : 'Add me to the list'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
