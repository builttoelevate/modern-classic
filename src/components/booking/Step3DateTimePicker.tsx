import { useEffect, useMemo, useRef, useState } from 'react';
import type { AvailabilitySlot, DayOfWeek, Location, ServiceVariation } from '../../lib/square/types';
import { WaitlistSheet } from './WaitlistSheet';

interface Props {
  /**
   * One or more variations to query. Multiple variations are passed when
   * the user picked "Any barber" on a per-barber service — we then fire
   * one /api/square/availability call per variation in parallel and
   * merge the results so the user sees the union of all three barbers'
   * openings for the day.
   */
  variations: ServiceVariation[];
  teamMemberId: string | undefined;
  selected: AvailabilitySlot | null;
  blockedSlots: string[];
  location: Location | null;
  onPick: (slot: AvailabilitySlot) => void;
  /** Service name for the waitlist email subject + body. */
  serviceName: string;
  /** Barber name (or "any barber") for the waitlist email body. */
  barberName: string;
  /** Optional prefill from earlier wizard steps so the waitlist form is faster. */
  prefillName?: string;
  prefillEmail?: string;
  prefillPhone?: string;
}

const SHOP_TZ = 'America/New_York';
const DAY_KEYS: DayOfWeek[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Don't let the user navigate forward forever — Square stops returning
// availability beyond Michael's configured booking horizon anyway. Three
// months of forward navigation is plenty for a barbershop.
const MAX_MONTHS_FORWARD = 3;

interface YearMonth {
  year: number;
  month: number; // 1-indexed
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayInShopTz(): { year: number; month: number; day: number; weekday: DayOfWeek } {
  return getLocalParts(new Date());
}

function getLocalParts(d: Date): { year: number; month: number; day: number; weekday: DayOfWeek } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday').toUpperCase().slice(0, 3) as DayOfWeek,
  };
}

function localDateToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: SHOP_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(utc);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const h = get('hour') === '24' ? '00' : get('hour');
    const localAsUtc = Date.UTC(
      Number(get('year')),
      Number(get('month')) - 1,
      Number(get('day')),
      Number(h),
      Number(get('minute')),
      Number(get('second')),
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = target - localAsUtc;
    if (diff === 0) break;
    utc = new Date(utc.getTime() + diff);
  }
  return utc;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// What weekday (0=Sun..6=Sat) the 1st of the given month falls on, in shop tz.
function firstOfMonthWeekday(year: number, month: number): number {
  const utc = localDateToUtc(year, month, 1, 12, 0);
  const w = getLocalParts(utc).weekday;
  return DAY_KEYS.indexOf(w);
}

interface CalendarDay {
  dateKey: string;
  dayNum: number;
  weekday: DayOfWeek;
  isClosed: boolean;
  isPast: boolean;
  closedReason?: 'sunday' | 'business-hours';
}

function buildMonthDays(year: number, month: number, location: Location | null): CalendarDay[] {
  const closedDays = new Set<DayOfWeek>(['SUN']);
  const periods = location?.business_hours?.periods;
  if (periods && periods.length > 0) {
    const open = new Set<DayOfWeek>(periods.map((p) => p.day_of_week));
    for (const d of DAY_KEYS) if (!open.has(d)) closedDays.add(d);
  }

  const today = todayInShopTz();
  const isCurrentMonth = year === today.year && month === today.month;
  const total = daysInMonth(year, month);
  const out: CalendarDay[] = [];
  for (let day = 1; day <= total; day++) {
    const utc = localDateToUtc(year, month, day, 12, 0);
    const parts = getLocalParts(utc);
    const isClosed = closedDays.has(parts.weekday);
    const isPast = isCurrentMonth && day < today.day;
    out.push({
      dateKey: `${year}-${pad(month)}-${pad(day)}`,
      dayNum: day,
      weekday: parts.weekday,
      isClosed,
      isPast,
      closedReason: isClosed ? (parts.weekday === 'SUN' ? 'sunday' : 'business-hours') : undefined,
    });
  }
  return out;
}

function nextMonth({ year, month }: YearMonth): YearMonth {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function prevMonth({ year, month }: YearMonth): YearMonth {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function ymKey(ym: YearMonth): string {
  return `${ym.year}-${pad(ym.month)}`;
}

// When "Any barber" is picked on a per-barber service we hit Square once per
// variation and concatenate the results. Two barbers can be free at the same
// startAtUtc — show that bucket once and let Square's randomness pick which
// one a customer ends up with. (We keep the FIRST entry per timestamp so the
// stable sort downstream is deterministic.)
function mergeSlots(slots: AvailabilitySlot[]): AvailabilitySlot[] {
  const seen = new Set<string>();
  const out: AvailabilitySlot[] = [];
  for (const s of slots) {
    if (seen.has(s.startAtUtc)) continue;
    seen.add(s.startAtUtc);
    out.push(s);
  }
  out.sort((a, b) => a.startAtUtc.localeCompare(b.startAtUtc));
  return out;
}

interface MonthState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  slots: AvailabilitySlot[];
  error?: string;
}

export function Step3DateTimePicker({
  variations,
  teamMemberId,
  selected,
  blockedSlots,
  location,
  onPick,
  serviceName,
  barberName,
  prefillName,
  prefillEmail,
  prefillPhone,
}: Props) {
  const variationKey = variations.map((v) => v.id).join(',');
  const today = useMemo(() => todayInShopTz(), []);
  const minMonth: YearMonth = { year: today.year, month: today.month };
  const maxMonth: YearMonth = (() => {
    let ym: YearMonth = { ...minMonth };
    for (let i = 0; i < MAX_MONTHS_FORWARD; i++) ym = nextMonth(ym);
    return ym;
  })();

  const [view, setView] = useState<YearMonth>(minMonth);
  const [monthState, setMonthState] = useState<MonthState>({ status: 'idle', slots: [] });
  const [activeDateKey, setActiveDateKey] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const [searchingNext, setSearchingNext] = useState(false);
  const [nextSearchError, setNextSearchError] = useState<string | null>(null);
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  const monthDays = useMemo(() => buildMonthDays(view.year, view.month, location), [view, location]);

  // Fetch availability for the visible month whenever it changes.
  useEffect(() => {
    if (variations.length === 0) return;
    const seq = ++requestSeq.current;
    setMonthState({ status: 'loading', slots: [] });

    // Search bounds: from the later of (now, first-of-month) up to the
    // first of next month. Square caps each call at 31 days; one month
    // is always under that.
    const monthFirstUtc = localDateToUtc(view.year, view.month, 1, 0, 0);
    const startUtc = monthFirstUtc.getTime() < Date.now() ? new Date() : monthFirstUtc;
    const next = nextMonth(view);
    const endUtc = localDateToUtc(next.year, next.month, 1, 0, 0);

    const requests = variations.map((v) => {
      const params = new URLSearchParams({
        serviceVariationId: v.id,
        startAt: startUtc.toISOString(),
        endAt: endUtc.toISOString(),
      });
      if (teamMemberId) params.set('teamMemberId', teamMemberId);
      return fetch(`/api/square/availability?${params.toString()}`).then(async (res) => {
        const body = await res.json();
        return { ok: res.ok && body?.ok, body };
      });
    });

    Promise.all(requests)
      .then((results) => {
        if (seq !== requestSeq.current) return;
        const failed = results.find((r) => !r.ok);
        if (failed) {
          setMonthState({
            status: 'error',
            slots: [],
            error: failed.body?.error?.detail ?? 'Could not load availability',
          });
          return;
        }
        const merged = mergeSlots(results.flatMap((r) => r.body.slots ?? []));
        setMonthState({ status: 'loaded', slots: merged });
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setMonthState({ status: 'error', slots: [], error: err?.message ?? 'Network error' });
      });
  }, [view, variationKey, teamMemberId, variations]);

  // Group the month's slots by dateKey so the calendar can show "has slots"
  // markers in O(1) per cell.
  const slotsByDate = useMemo(() => {
    const map = new Map<string, AvailabilitySlot[]>();
    for (const s of monthState.slots) {
      const list = map.get(s.dateKey);
      if (list) list.push(s);
      else map.set(s.dateKey, [s]);
    }
    return map;
  }, [monthState.slots]);

  // When a fresh month loads, default-pick the first day with slots so the
  // user lands on something useful instead of an empty pane.
  useEffect(() => {
    if (monthState.status !== 'loaded') return;
    if (activeDateKey && slotsByDate.has(activeDateKey)) return;
    const first = monthDays.find((d) => slotsByDate.has(d.dateKey));
    setActiveDateKey(first ? first.dateKey : null);
  }, [monthState.status, slotsByDate, monthDays, activeDateKey]);

  const blockedSet = useMemo(() => new Set(blockedSlots), [blockedSlots]);

  const canPrev = !(view.year === minMonth.year && view.month === minMonth.month);
  const canNext = !(view.year === maxMonth.year && view.month === maxMonth.month);

  // "Go to next available" — server hits Square across rolling 30-day windows
  // up to 60 days out and returns the soonest slot. We then jump the calendar
  // view to that month and let the existing default-pick effect highlight the
  // first day with openings.
  const goToNextAvailable = async () => {
    if (variations.length === 0) return;
    setSearchingNext(true);
    setNextSearchError(null);
    try {
      const params = new URLSearchParams();
      params.set('serviceVariationId', variations.map((v) => v.id).join(','));
      if (teamMemberId) params.set('teamMemberId', teamMemberId);
      const res = await fetch(`/api/square/next-available?${params.toString()}`);
      const data = (await res.json()) as { ok: boolean; slot?: AvailabilitySlot | null; error?: { detail: string } };
      if (!data.ok) {
        setNextSearchError(data.error?.detail || "Couldn't reach the calendar. Try again in a moment.");
        return;
      }
      if (!data.slot) {
        setNextSearchError(
          "No openings in the next 60 days for this combo. Join the waitlist and we'll text or email when one frees up.",
        );
        return;
      }
      const slotUtc = new Date(data.slot.startAtUtc);
      const parts = getLocalParts(slotUtc);
      setView({ year: parts.year, month: parts.month });
      setActiveDateKey(`${parts.year}-${pad(parts.month)}-${pad(parts.day)}`);
    } catch (err) {
      setNextSearchError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setSearchingNext(false);
    }
  };

  const activeSlots = activeDateKey ? slotsByDate.get(activeDateKey) ?? [] : [];
  const monthHasSlots = monthState.slots.length > 0;
  const monthIsEmpty = monthState.status === 'loaded' && !monthHasSlots;

  // Build the leading-blank cells for the month grid. If the 1st falls on
  // Wednesday (weekday=3), we need 3 empty cells before it.
  const firstWeekday = firstOfMonthWeekday(view.year, view.month);
  const blankCells = Array.from({ length: firstWeekday }, (_, i) => i);

  const showSuggestNextMonth =
    monthIsEmpty && view.year !== maxMonth.year || (monthIsEmpty && view.month < maxMonth.month);

  return (
    <div className="bw-step">
      <div className="bw-step-head">
        <h2>Pick a date and time</h2>
        <p>All times shown in shop time (Eastern). Closed Sundays.</p>
      </div>

      <div className="bw-cal">
        <div className="bw-cal-head">
          <button
            type="button"
            className="bw-cal-nav"
            disabled={!canPrev}
            onClick={() => canPrev && setView((v) => prevMonth(v))}
            aria-label="Previous month"
          >
            ‹
          </button>
          <div className="bw-cal-title" aria-live="polite">
            {MONTH_LABELS[view.month - 1]} {view.year}
          </div>
          <button
            type="button"
            className="bw-cal-nav"
            disabled={!canNext}
            onClick={() => canNext && setView((v) => nextMonth(v))}
            aria-label="Next month"
          >
            ›
          </button>
        </div>

        <div className="bw-cal-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>

        <div className="bw-cal-grid" role="grid" aria-label={`${MONTH_LABELS[view.month - 1]} ${view.year}`}>
          {blankCells.map((i) => (
            <span key={`blank-${i}`} className="bw-cal-blank" />
          ))}
          {monthDays.map((d) => {
            const hasSlots = slotsByDate.has(d.dateKey);
            const isLoading = monthState.status === 'loading';
            const isSelected = activeDateKey === d.dateKey;
            const disabled = d.isClosed || d.isPast || (!isLoading && !hasSlots);
            const title = d.isPast
              ? 'In the past'
              : d.isClosed
                ? 'Closed'
                : !hasSlots && !isLoading
                  ? 'No openings'
                  : `${d.dayNum} — available`;
            return (
              <button
                key={d.dateKey}
                type="button"
                role="gridcell"
                className="bw-cal-day"
                data-selected={isSelected}
                data-has-slots={hasSlots}
                data-loading={isLoading}
                disabled={disabled}
                aria-disabled={disabled}
                aria-label={title}
                onClick={() => !disabled && setActiveDateKey(d.dateKey)}
              >
                <span className="bw-cal-day-num">{d.dayNum}</span>
                {hasSlots && <span className="bw-cal-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {monthState.status === 'loading' && (
          <div className="bw-cal-foot">
            <span className="bw-spinner" aria-hidden="true" />
            <span>Loading {MONTH_LABELS[view.month - 1]}'s openings…</span>
          </div>
        )}

        {monthState.status === 'error' && (
          <div className="bw-empty" style={{ marginTop: 'var(--space-4)' }}>
            <strong>Couldn't load this month</strong>
            <span>{monthState.error}</span>
          </div>
        )}

        {monthIsEmpty && (
          <div className="bw-empty" style={{ marginTop: 'var(--space-4)' }}>
            <strong>No openings in {MONTH_LABELS[view.month - 1]}.</strong>
            <span>
              Jump to the next open date, or join the waitlist and we'll reach
              out the moment something frees up.
            </span>
            {nextSearchError && (
              <span className="bw-empty__error" role="alert">
                {nextSearchError}
              </span>
            )}
            <div className="bw-empty-actions">
              <button
                type="button"
                className="bw-btn"
                disabled={searchingNext}
                onClick={goToNextAvailable}
              >
                {searchingNext ? 'Searching…' : 'Go to next available →'}
              </button>
              <button
                type="button"
                className="bw-btn bw-btn--ghost"
                onClick={() => setWaitlistOpen(true)}
              >
                Join the waitlist
              </button>
            </div>
            <span className="bw-empty__or">
              or call <a className="link-gold" href="tel:+17402974462">740-297-4462</a>
            </span>
          </div>
        )}
      </div>

      <WaitlistSheet
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        serviceName={serviceName}
        barberName={barberName}
        serviceVariationId={variations[0]?.id ?? null}
        teamMemberId={teamMemberId ?? null}
        prefillName={prefillName}
        prefillEmail={prefillEmail}
        prefillPhone={prefillPhone}
      />

      {activeDateKey && monthState.status === 'loaded' && activeSlots.length > 0 && (
        <div className="bw-cal-slots">
          <div className="bw-cal-slots-head">
            {formatLongDate(activeDateKey)}
          </div>
          <div className="bw-slots" role="listbox" aria-label="Available times">
            {activeSlots.map((slot) => {
              const isSelected = selected?.startAtUtc === slot.startAtUtc;
              const isBlocked = blockedSet.has(slot.startAtUtc);
              return (
                <button
                  key={slot.startAtUtc}
                  type="button"
                  className="bw-slot"
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected}
                  disabled={isBlocked}
                  onClick={() => onPick(slot)}
                >
                  {slot.startTimeLabel}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/*
        Persistent waitlist offer. Stays out of the way unless the customer
        actually scrolled past the calendar and didn't click anything — at
        which point a quiet line is more useful than a louder CTA.
      */}
      <p className="bw-waitlist-hint">
        Don't see a time that works?{' '}
        <button
          type="button"
          className="bw-waitlist-hint__btn"
          onClick={() => setWaitlistOpen(true)}
        >
          Join the waitlist
        </button>
        .
      </p>
    </div>
  );
}

function formatLongDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const utc = localDateToUtc(y, m, d, 12, 0);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(utc);
}
