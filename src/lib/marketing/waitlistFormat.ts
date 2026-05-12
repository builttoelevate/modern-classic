// Format helpers for the barber-dashboard waitlist card (and any
// future surface that renders a stored WaitlistEntry).
//
// The join-waitlist form defaults every day-of-week chip ON and lets
// the customer NARROW from there. A customer who doesn't touch the
// chips ends up storing daysOfWeek = ['mon','tue','wed','thu','fri',
// 'sat'] — and the dashboard used to literally render that as
// "mon, tue, wed, thu, fri, sat", which reads as a deliberate
// 6-day pick when it's actually the no-restriction default. Same
// risk for the morning/afternoon/evening chips. These helpers
// detect the "all on" case and compress it to "Any day" / "Any
// time" so the card surfaces the real signal.
//
// Pure functions — no I/O — so they're trivial to inline in admin
// tools, notification emails, etc. as those surfaces appear.

/** Shop's open days, in display order. Sunday excluded (shop is
 *  closed Sundays). When daysOfWeek matches this set, the customer
 *  did not restrict by weekday. */
const OPEN_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type OpenDay = (typeof OPEN_DAYS)[number];

const DAY_LABELS: Record<OpenDay, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};

const DAY_ORDER: Record<OpenDay, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
};

const TIMES = ['morning', 'afternoon', 'evening'] as const;
type TimeOfDay = (typeof TIMES)[number];

const TIME_LABELS: Record<TimeOfDay, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
};

const TIME_ORDER: Record<TimeOfDay, number> = {
  morning: 0,
  afternoon: 1,
  evening: 2,
};

function isOpenDay(s: string): s is OpenDay {
  return (OPEN_DAYS as readonly string[]).includes(s);
}

function isTimeOfDay(s: string): s is TimeOfDay {
  return (TIMES as readonly string[]).includes(s);
}

/**
 * "Mon, Wed, Fri" for narrowed selections, or "Any day" when the
 * customer didn't restrict (empty array, or full open-day set).
 */
export function formatWaitlistDays(arr: readonly string[] | undefined): string {
  if (!arr || arr.length === 0) return 'Any day';
  const known = arr.filter(isOpenDay);
  if (known.length === 0) return 'Any day';
  // "All open days picked" is functionally "any day" — render as such
  // so the barber doesn't see a stale 6-token enumeration.
  if (known.length === OPEN_DAYS.length) return 'Any day';
  const sorted = [...known].sort((a, b) => DAY_ORDER[a] - DAY_ORDER[b]);
  return sorted.map((d) => DAY_LABELS[d]).join(', ');
}

/**
 * "Morning, Evening" for narrowed selections, or "Any time" when
 * the customer didn't restrict.
 */
export function formatWaitlistTimes(arr: readonly string[] | undefined): string {
  if (!arr || arr.length === 0) return 'Any time';
  const known = arr.filter(isTimeOfDay);
  if (known.length === 0) return 'Any time';
  if (known.length === TIMES.length) return 'Any time';
  const sorted = [...known].sort((a, b) => TIME_ORDER[a] - TIME_ORDER[b]);
  return sorted.map((t) => TIME_LABELS[t]).join(', ');
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function parseYmd(ymd: string): Date | null {
  // Avoid Date constructor's "YYYY-MM-DD parses as UTC midnight" gotcha
  // by building the date in local time explicitly. The waitlist form
  // stores shop-local dates, so we want to render them at face value.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  const dt = new Date(y, mo - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function fmtShort(d: Date): string {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function fmtWeekdayShort(d: Date): string {
  return `${WEEKDAY_SHORT[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * "Wed, May 13" for a single-day window, "May 13 → May 19" for a
 * range. Empty string when either input is missing or malformed —
 * caller hides the row.
 */
export function formatWaitlistWindow(
  dateFrom: string | undefined | null,
  dateTo: string | undefined | null,
): string {
  if (!dateFrom || !dateTo) return '';
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  if (!from || !to) return '';
  if (from.getTime() === to.getTime()) return fmtWeekdayShort(from);
  return `${fmtShort(from)} → ${fmtShort(to)}`;
}
