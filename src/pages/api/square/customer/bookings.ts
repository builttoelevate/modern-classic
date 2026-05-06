import type { APIRoute } from 'astro';
import { AuthRequiredError, requireSession, refreshSessionCookie } from '../../../../lib/auth/middleware';
import { getCustomerBookings } from '../../../../lib/square/customerBookings';
import { listLinkedPeople } from '../../../../lib/customer/profileLinks';
import { isAuthConfigured } from '../../../../lib/auth/session';

export const prerender = false;

// Mirrors the parent + linked-people merge that lives on the
// my-bookings.astro page so the client-side refresh() hook in
// MyBookingsList can pull a complete picture without reloading the
// whole page. Without this, cancelling one group-member booking made
// every other group-member booking visually disappear from the list
// (since the prior shape of this endpoint only returned the parent's
// own bookings); the underlying Square data was always intact, but
// the UI looked broken until a full page reload re-ran the server-
// side merge.
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
    const linkedPeople = await listLinkedPeople(session.customerId).catch(() => []);
    const [parentBookings, ...kidResults] = await Promise.all([
      getCustomerBookings(session.customerId),
      // Each linked person's bookings, in parallel. Failures fall
      // through to empty so one bad lookup doesn't blank the page.
      ...linkedPeople.map((lp) =>
        getCustomerBookings(lp.customerId)
          .then((kb) => ({ person: lp, bookings: kb }))
          .catch(() => ({
            person: lp,
            bookings: { upcoming: [], past: [] },
          })),
      ),
    ]);
    const upcoming = [...parentBookings.upcoming];
    const past = [...parentBookings.past];
    for (const r of kidResults) {
      for (const ub of r.bookings.upcoming) {
        upcoming.push({ ...ub, bookingFor: r.person.displayName });
      }
      for (const pb of r.bookings.past) {
        past.push({ ...pb, bookingFor: r.person.displayName });
      }
    }
    upcoming.sort(
      (a, b) => new Date(a.startAtUtc).getTime() - new Date(b.startAtUtc).getTime(),
    );
    past.sort(
      (a, b) => new Date(b.startAtUtc).getTime() - new Date(a.startAtUtc).getTime(),
    );
    return new Response(JSON.stringify({ ok: true, upcoming, past }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshSessionCookie(session),
      },
    });
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
