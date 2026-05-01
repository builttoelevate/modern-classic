// Phase 6 Part A — relative-time formatting in America/New_York.
//
// "Today 2:30 PM" / "Tomorrow 9:00 AM" / "Friday 10:00 AM" / "Mon, May 12 9:00 AM"
// All comparisons happen in shop-local time so DST and date-rollover behave.

const SHOP_TZ = 'America/New_York';

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const WEEKDAY_LONG = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  weekday: 'long',
});

const WEEKDAY_SHORT_MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

const YMD_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function ymdLocal(date: Date): string {
  // 'en-CA' yields YYYY-MM-DD which is sortable + comparable.
  return YMD_PARTS.format(date);
}

function diffDaysShopLocal(target: Date, now: Date): number {
  // Use the YYYY-MM-DD representation in the shop tz so the difference
  // is measured in calendar days, not 24h windows.
  const t = ymdLocal(target);
  const n = ymdLocal(now);
  // Convert both to a day-number by parsing as UTC midnight (safe — we
  // only care about the date delta, not wall-clock).
  const tMs = Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(5, 7)) - 1,
    Number(t.slice(8, 10)),
  );
  const nMs = Date.UTC(
    Number(n.slice(0, 4)),
    Number(n.slice(5, 7)) - 1,
    Number(n.slice(8, 10)),
  );
  return Math.round((tMs - nMs) / 86_400_000);
}

export function formatRelativeSlot(startAtUtc: string, now: Date = new Date()): string {
  const target = new Date(startAtUtc);
  const time = TIME_FMT.format(target);
  const days = diffDaysShopLocal(target, now);

  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${WEEKDAY_LONG.format(target)} ${time}`;
  return `${WEEKDAY_SHORT_MONTH_DAY.format(target)} ${time}`;
}

export function isWithinDays(startAtUtc: string, days: number, now: Date = new Date()): boolean {
  const target = new Date(startAtUtc);
  const delta = diffDaysShopLocal(target, now);
  return delta <= days;
}
