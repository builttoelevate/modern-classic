// POST /api/barber/time-off/recurring — add a weekly recurring
// block rule. Stored as shop-local time-of-day + day-of-week mask
// so DST shifts don't drift it (e.g. "Mon, Wed 12:00–13:00, starts
// 2026-05-01, no end").
//
// Auth: requireBarberSession.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import { addRecurringBlock } from '../../../../lib/barber/timeBlocks';

export const prerender = false;

function logBarber(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

interface RequestBody {
  startTimeShop?: string;
  endTimeShop?: string;
  daysOfWeek?: string[];
  startsOn?: string;
  endsOn?: string;
  note?: string;
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const b = (body ?? {}) as RequestBody;
  const startTimeShop = typeof b.startTimeShop === 'string' ? b.startTimeShop.trim() : '';
  const endTimeShop = typeof b.endTimeShop === 'string' ? b.endTimeShop.trim() : '';
  const startsOn = typeof b.startsOn === 'string' ? b.startsOn.trim() : '';
  const endsOn = typeof b.endsOn === 'string' ? b.endsOn.trim() : '';
  const note = typeof b.note === 'string' ? b.note.trim() : undefined;
  const days = Array.isArray(b.daysOfWeek)
    ? b.daysOfWeek.filter((d): d is string => typeof d === 'string')
    : [];

  try {
    const block = await addRecurringBlock(session.barberId, {
      startTimeShop,
      endTimeShop,
      daysOfWeek: days,
      startsOn,
      endsOn: endsOn || undefined,
      note,
    });
    logBarber({
      phase: 'time-off-recurring-added',
      barberId: session.barberId,
      blockId: block.id,
      days: block.daysOfWeek,
      startTimeShop: block.startTimeShop,
      endTimeShop: block.endTimeShop,
      startsOn: block.startsOn,
      endsOn: block.endsOn ?? null,
    });
    return new Response(
      JSON.stringify({ ok: true, block }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshBarberSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return fail(400, 'BAD_REQUEST', detail);
  }
};
