import type { APIRoute } from 'astro';
import { AuthRequiredError, requireSession, refreshSessionCookie } from '../../../../lib/auth/middleware';
import { getMergedBookingsForSession } from '../../../../lib/customer/familyBookings';
import { adoptMissingGroupSiblings } from '../../../../lib/customer/groupSelfHeal';
import { isAuthConfigured } from '../../../../lib/auth/session';

export const prerender = false;

// Mirror of /my-bookings.astro's data path, used by MyBookingsList's
// client-side refresh() after a cancel/reschedule. Both call sites
// share getMergedBookingsForSession so they can never drift — the
// helper handles family vs legacy parent→kid model selection
// internally.
export const GET: APIRoute = async ({ request }) => {
  if (!isAuthConfigured()) {
    return Response.json(
      { ok: false, error: { code: 'AUTH_NOT_CONFIGURED', detail: 'Auth not configured.' } },
      { status: 503 },
    );
  }

  let session;
  try {
    session = requireSession(request);
  } catch (err) {
    if (err instanceof AuthRequiredError) return err.response;
    throw err;
  }

  try {
    const merged = await getMergedBookingsForSession(session.customerId);

    // Phone-based self-heal — same call /my-bookings makes, kept here
    // so a refresh after cancel keeps any orphaned group siblings
    // visible without a hard reload.
    try {
      await adoptMissingGroupSiblings(
        session.customerId,
        merged.knownCustomerIds,
        merged.bookings,
      );
    } catch {
      // Self-heal failures are non-fatal; the existing list is good
      // enough to render.
    }

    merged.bookings.upcoming.sort(
      (a, b) => new Date(a.startAtUtc).getTime() - new Date(b.startAtUtc).getTime(),
    );
    merged.bookings.past.sort(
      (a, b) => new Date(b.startAtUtc).getTime() - new Date(a.startAtUtc).getTime(),
    );

    return new Response(
      JSON.stringify({
        ok: true,
        upcoming: merged.bookings.upcoming,
        past: merged.bookings.past,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(
      `[BOOK] ${JSON.stringify({ ts: new Date().toISOString(), phase: 'customer-bookings-failed', detail })}`,
    );
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail: 'Could not load bookings.' } },
      { status: 500 },
    );
  }
};
