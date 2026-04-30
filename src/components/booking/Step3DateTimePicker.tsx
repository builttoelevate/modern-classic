import { useEffect, useMemo, useRef, useState } from 'react';
import type { AvailabilitySlot, DayOfWeek, Location, ServiceVariation } from '../../lib/square/types';

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
}

const SHOP_TZ = 'America/New_York';
const DAY_KEYS: DayOfWeek[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface CalendarDay {
  dateKey: string;
  jsDate: Date;
  weekday: string;
  dayNum: string;
  monthShort: string;
  isClosed: boolean;
  closedReason?: 'sunday' | 'business-hours';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
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
  const weekdayLabel = get('weekday').toUpperCase().slice(0, 3) as DayOfWeek;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdayLabel,
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

function buildCalendar(location: Location | null): CalendarDay[] {
  const closedDays = new Set<DayOfWeek>(['SUN']);
  // If business hours include explicit periods, exclude any DAY not present.
  const periods = location?.business_hours?.periods;
  if (periods && periods.length > 0) {
    const open = new Set<DayOfWeek>(periods.map((p) => p.day_of_week));
    for (const d of DAY_KEYS) {
      if (!open.has(d)) closedDays.add(d);
    }
  }

  const days: CalendarDay[] = [];
  const today = new Date();
  const todayParts = getLocalParts(today);
  const baseUtc = localDateToUtc(todayParts.year, todayParts.month, todayParts.day, 12, 0);

  for (let i = 0; i < 14; i++) {
    const utc = new Date(baseUtc.getTime() + i * 24 * 60 * 60 * 1000);
    const parts = getLocalParts(utc);
    const dateKey = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    const dtfDay = new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ, weekday: 'short' });
    const dtfMonth = new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ, month: 'short' });
    const isClosed = closedDays.has(parts.weekday);
    days.push({
      dateKey,
      jsDate: utc,
      weekday: dtfDay.format(utc),
      dayNum: String(parts.day),
      monthShort: dtfMonth.format(utc),
      isClosed,
      closedReason: isClosed ? (parts.weekday === 'SUN' ? 'sunday' : 'business-hours') : undefined,
    });
  }
  return days;
}

interface SlotsState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  slots: AvailabilitySlot[];
  error?: string;
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

export function Step3DateTimePicker({
  variations,
  teamMemberId,
  selected,
  blockedSlots,
  location,
  onPick,
}: Props) {
  const variationKey = variations.map((v) => v.id).join(',');
  const calendar = useMemo(() => buildCalendar(location), [location]);
  const firstOpenIdx = calendar.findIndex((d) => !d.isClosed);
  const [activeDateKey, setActiveDateKey] = useState<string | null>(
    calendar[firstOpenIdx]?.dateKey ?? null,
  );
  const [slotsState, setSlotsState] = useState<SlotsState>({ status: 'idle', slots: [] });
  const [windowState, setWindowState] = useState<{ status: 'idle' | 'checking' | 'empty' | 'has-slots'; firstSlots: AvailabilitySlot[] }>({
    status: 'idle',
    firstSlots: [],
  });
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!activeDateKey || variations.length === 0) return;
    const seq = ++requestSeq.current;
    setSlotsState({ status: 'loading', slots: [] });
    const day = calendar.find((d) => d.dateKey === activeDateKey);
    if (!day) {
      setSlotsState({ status: 'idle', slots: [] });
      return;
    }
    const [y, m, d] = activeDateKey.split('-').map(Number);
    const startUtc = localDateToUtc(y, m, d, 0, 0);
    const endUtc = localDateToUtc(y, m, d + 1, 0, 0);

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
          setSlotsState({
            status: 'error',
            slots: [],
            error: failed.body?.error?.detail ?? 'Could not load availability',
          });
          return;
        }
        const merged = mergeSlots(results.flatMap((r) => r.body.slots ?? []));
        setSlotsState({ status: 'loaded', slots: merged });
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setSlotsState({ status: 'error', slots: [], error: err?.message ?? 'Network error' });
      });
  }, [activeDateKey, variationKey, teamMemberId, calendar, variations]);

  // Phase 4 A.1 — when a single date has zero slots, also probe the full
  // 14-day window so we can either suggest a different date or, if the
  // entire window is empty, surface a friendly "call us" screen.
  useEffect(() => {
    if (slotsState.status !== 'loaded' || slotsState.slots.length > 0 || variations.length === 0) {
      setWindowState({ status: 'idle', firstSlots: [] });
      return;
    }
    const seq = ++requestSeq.current;
    setWindowState({ status: 'checking', firstSlots: [] });
    const today = calendar[0];
    const last = calendar[calendar.length - 1];
    if (!today || !last) {
      setWindowState({ status: 'empty', firstSlots: [] });
      return;
    }
    const [sy, sm, sd] = today.dateKey.split('-').map(Number);
    const [ey, em, ed] = last.dateKey.split('-').map(Number);
    const startUtc = localDateToUtc(sy, sm, sd, 0, 0);
    const endUtc = localDateToUtc(ey, em, ed + 1, 0, 0);
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
        const all = mergeSlots(results.flatMap((r) => (r.ok ? r.body.slots ?? [] : [])));
        if (all.length === 0) setWindowState({ status: 'empty', firstSlots: [] });
        else setWindowState({ status: 'has-slots', firstSlots: all.slice(0, 4) });
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        setWindowState({ status: 'empty', firstSlots: [] });
      });
  }, [slotsState.status, slotsState.slots.length, calendar, variationKey, teamMemberId, variations]);

  const blockedSet = useMemo(() => new Set(blockedSlots), [blockedSlots]);

  const suggestedDates = useMemo(() => {
    const seenDates = new Set<string>();
    const out: { dateKey: string; label: string }[] = [];
    for (const slot of windowState.firstSlots) {
      if (seenDates.has(slot.dateKey)) continue;
      seenDates.add(slot.dateKey);
      const day = calendar.find((d) => d.dateKey === slot.dateKey);
      if (!day) continue;
      out.push({ dateKey: slot.dateKey, label: `${day.weekday} ${day.dayNum}` });
      if (out.length >= 3) break;
    }
    return out;
  }, [windowState.firstSlots, calendar]);

  return (
    <div className="bw-step">
      <div className="bw-step-head">
        <h2>Pick a date and time</h2>
        <p>All times shown in shop time (Eastern). Closed Sundays.</p>
      </div>

      <div className="bw-dt">
        <div className="bw-date-list" role="listbox" aria-label="Available dates">
          {calendar.map((d) => (
            <button
              key={d.dateKey}
              type="button"
              className="bw-date"
              data-selected={d.dateKey === activeDateKey}
              disabled={d.isClosed}
              aria-disabled={d.isClosed}
              role="option"
              aria-selected={d.dateKey === activeDateKey}
              onClick={() => !d.isClosed && setActiveDateKey(d.dateKey)}
            >
              <span className="bw-date-day">{d.weekday}</span>
              <span className="bw-date-num">{d.dayNum}</span>
              <span className="bw-date-month">{d.monthShort}{d.isClosed ? ' · closed' : ''}</span>
            </button>
          ))}
        </div>

        <div>
          {slotsState.status === 'loading' && (
            <div className="bw-skel-grid" aria-busy="true" aria-label="Loading available times">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bw-skel" />
              ))}
            </div>
          )}

          {slotsState.status === 'error' && (
            <div className="bw-empty">
              <strong>Couldn't load times</strong>
              <span>{slotsState.error}</span>
            </div>
          )}

          {slotsState.status === 'loaded' && slotsState.slots.length > 0 && (
            <div className="bw-slots" role="listbox" aria-label="Available times">
              {slotsState.slots.map((slot) => {
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
          )}

          {slotsState.status === 'loaded' && slotsState.slots.length === 0 && (
            <div className="bw-empty">
              <strong>No openings on this day</strong>
              {windowState.status === 'checking' && <span>Checking other days…</span>}
              {windowState.status === 'has-slots' && (
                <>
                  <span>Try one of these instead:</span>
                  <div className="bw-empty-suggestions">
                    {suggestedDates.map((s) => (
                      <button
                        key={s.dateKey}
                        type="button"
                        onClick={() => setActiveDateKey(s.dateKey)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {windowState.status === 'empty' && (
                <span>
                  No openings in the next two weeks. Please call us at{' '}
                  <a className="link-gold" href="tel:+17402974462">740-297-4462</a>.
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
