import type { APIRoute } from 'astro';
import { AuthRequiredError, requireSession, refreshSessionCookie } from '../../../../lib/auth/middleware';
import { getCustomerBookings } from '../../../../lib/square/customerBookings';
import { isAuthConfigured } from '../../../../lib/auth/session';

export const prerender = false;

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
    const data = await getCustomerBookings(session.customerId);
    return new Response(JSON.stringify({ ok: true, ...data }), {
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
