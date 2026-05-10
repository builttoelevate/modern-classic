import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import { rescheduleBookingCore } from '../../../../lib/booking/rescheduleCore';

export const prerender = false;

// Barber-initiated reschedule. Same two-step (create new, cancel old)
// as the admin endpoint, with two added constraints:
//
//   1. Auth is a barber session, not Basic Auth.
//   2. The booking's team_member_id must match the logged-in barber.
//      Barbers can move their own appointments around but can't grab
//      a teammate's row.
//
// Service stays the same; the barber may not swap themselves out —
// teamMemberId is forced to the existing booking's barber.

interface BarberReschedulePayload {
  oldBookingId: string;
  newStartAtUtc: string;
}

function isValidPayload(p: unknown): p is BarberReschedulePayload {
  if (!p || typeof p !== 'object') return false;
  const r = p as Partial<BarberReschedulePayload>;
  if (typeof r.oldBookingId !== 'string' || !r.oldBookingId) return false;
  if (typeof r.newStartAtUtc !== 'string') return false;
  if (isNaN(new Date(r.newStartAtUtc).getTime())) return false;
  return true;
}

function logAction(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
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
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }
  if (!isValidPayload(body)) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Missing required fields.' } },
      { status: 400 },
    );
  }

  const result = await rescheduleBookingCore(
    {
      oldBookingId: body.oldBookingId,
      newStartAtUtc: body.newStartAtUtc,
      actorPrefix: `barber-${session.barberId}`,
    },
    (booking) => {
      const assigned = booking.appointment_segments?.[0]?.team_member_id;
      if (!assigned || assigned !== session.barberId) {
        return {
          ok: false,
          status: 403,
          error: {
            code: 'FORBIDDEN',
            detail: 'You can only reschedule your own appointments.',
          },
        };
      }
      return null;
    },
  );

  if (!result.ok) {
    logAction({
      phase: 'barber-reschedule-failed',
      barberId: session.barberId,
      oldBookingId: body.oldBookingId,
      code: result.error.code,
      detail: result.error.detail,
    });
    return Response.json({ ok: false, error: result.error }, { status: result.status });
  }

  if (result.warning) {
    logAction({
      phase: 'barber-reschedule-cancel-failed',
      severity: 'manual-cleanup-needed',
      barberId: session.barberId,
      oldBookingId: result.oldBookingId,
      newBookingId: result.newBookingId,
    });
    return Response.json({
      ok: true,
      newBookingId: result.newBookingId,
      newBookingVersion: result.newBookingVersion,
      oldBookingId: result.oldBookingId,
      warning: result.warning,
    });
  }

  logAction({
    phase: 'barber-reschedule-success',
    barberId: session.barberId,
    oldBookingId: result.oldBookingId,
    newBookingId: result.newBookingId,
  });
  return Response.json({
    ok: true,
    newBookingId: result.newBookingId,
    newBookingVersion: result.newBookingVersion,
    oldBookingId: result.oldBookingId,
  });
};
