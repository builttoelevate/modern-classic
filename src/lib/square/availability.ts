import { squareFetch } from './client';
import { MODERN_CLASSIC_LOCATION_ID } from './locations';
import type { AvailabilityResponse, AvailabilitySlot } from './types';

export const SHOP_TIMEZONE = 'America/New_York';

const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

interface SearchAvailabilityParams {
  serviceVariationId: string;
  teamMemberId?: string;
  startAt: Date;
  endAt: Date;
}

interface ParsedLocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: string;
}

function parseLocalParts(date: Date, timeZone: string): ParsedLocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
    weekday: get('weekday'),
  };
}

export function formatDateKey(utc: Date): string {
  const p = parseLocalParts(utc, SHOP_TIMEZONE);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatTimeLabel(utc: Date): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return dtf.format(utc);
}

export function formatDateLong(utc: Date): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return dtf.format(utc);
}

export function formatLocalDateTime(utc: Date): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  return dtf.format(utc);
}

// Convert a calendar date in America/New_York (year/month/day at given local
// hour/minute) to a UTC Date instance. Uses an iterative correction so DST
// transitions resolve correctly without pulling in date-fns-tz.
export function localDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // First guess: treat the local components as if they were UTC.
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  // Iterate twice (covers DST) — compute what the local representation of
  // `utc` actually is, and shift by the gap.
  for (let i = 0; i < 2; i++) {
    const p = parseLocalParts(utc, SHOP_TIMEZONE);
    const localAsUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = target - localAsUtc;
    if (diff === 0) break;
    utc = new Date(utc.getTime() + diff);
  }
  return utc;
}

// Returns the UTC start (local 00:00) and end (local 24:00) of a given local
// calendar day in America/New_York.
export function localDayBoundsUtc(year: number, month: number, day: number): { startUtc: Date; endUtc: Date } {
  return {
    startUtc: localDateToUtc(year, month, day, 0, 0),
    endUtc: localDateToUtc(year, month, day + 1, 0, 0),
  };
}

export async function searchAvailability(
  params: SearchAvailabilityParams,
): Promise<AvailabilitySlot[]> {
  const { serviceVariationId, teamMemberId, startAt, endAt } = params;

  if (!serviceVariationId) {
    throw new Error('serviceVariationId is required');
  }
  if (!(startAt instanceof Date) || isNaN(startAt.getTime())) {
    throw new Error('startAt must be a valid Date');
  }
  if (!(endAt instanceof Date) || isNaN(endAt.getTime())) {
    throw new Error('endAt must be a valid Date');
  }
  if (endAt.getTime() <= startAt.getTime()) {
    throw new Error('endAt must be after startAt');
  }
  if (endAt.getTime() - startAt.getTime() > MAX_RANGE_MS) {
    throw new Error("Square availability range is capped at 31 days; reduce the window.");
  }

  const segmentFilter: {
    service_variation_id: string;
    team_member_id_filter?: { any: string[] };
  } = { service_variation_id: serviceVariationId };
  if (teamMemberId) {
    segmentFilter.team_member_id_filter = { any: [teamMemberId] };
  }

  const body = {
    query: {
      filter: {
        start_at_range: {
          start_at: startAt.toISOString(),
          end_at: endAt.toISOString(),
        },
        location_id: MODERN_CLASSIC_LOCATION_ID,
        segment_filters: [segmentFilter],
      },
    },
  };

  const res = await squareFetch<AvailabilityResponse>(
    '/v2/bookings/availability/search',
    { method: 'POST', body },
  );

  const slots: AvailabilitySlot[] = [];
  for (const a of res.availabilities ?? []) {
    const seg = a.appointment_segments?.[0];
    if (!seg) continue;
    const utc = new Date(a.start_at);
    if (isNaN(utc.getTime())) continue;
    slots.push({
      startAtUtc: a.start_at,
      startAtLocal: utc.toISOString(),
      startTimeLabel: formatTimeLabel(utc),
      dateKey: formatDateKey(utc),
      teamMemberId: seg.team_member_id,
      serviceVariationId: seg.service_variation_id,
      durationMinutes: seg.duration_minutes ?? 30,
    });
  }

  // Sort earliest first.
  slots.sort((a, b) => a.startAtUtc.localeCompare(b.startAtUtc));
  return slots;
}
