import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../lib/admin/auth';
import { SquareApiError } from '../../../lib/square/client';
import { deleteCustomer, getCustomerById } from '../../../lib/square/customers';
import { getLinkedParent, unlinkPerson } from '../../../lib/customer/profileLinks';
import { getCustomerBookings } from '../../../lib/square/customerBookings';

export const prerender = false;

// Hard-delete a customer record from Square. Used by the admin
// /admin/customers page to clean up stray test accounts.
//
// Two safety gates:
//   1. confirmId in the request body must equal customerId — the UI
//      asks the operator to type the id back, so this guards against
//      a stray click hitting the wrong row.
//   2. Refuse if the customer has ANY bookings on file (upcoming or
//      past). Customers with history should be preserved for the
//      audit trail; only zero-history records (typically test
//      accounts) are eligible for delete here.

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const customerId = typeof b.customerId === 'string' ? b.customerId.trim() : '';
  const confirmId = typeof b.confirmId === 'string' ? b.confirmId.trim() : '';
  if (!customerId) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'customerId is required.' } },
      { status: 400 },
    );
  }
  if (confirmId !== customerId) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'CONFIRM_MISMATCH',
          detail: 'Confirmation id does not match the customer id.',
        },
      },
      { status: 400 },
    );
  }

  let existing;
  try {
    existing = await getCustomerById(customerId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json(
      { ok: false, error: { code: 'LOOKUP_FAILED', detail } },
      { status: 502 },
    );
  }
  if (!existing) {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', detail: 'No customer with that id.' } },
      { status: 404 },
    );
  }

  let bookings;
  try {
    bookings = await getCustomerBookings(customerId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({ phase: 'delete-customer-bookings-check-failed', customerId, detail });
    return Response.json(
      { ok: false, error: { code: 'BOOKINGS_CHECK_FAILED', detail } },
      { status: 502 },
    );
  }
  const totalBookings = bookings.upcoming.length + bookings.past.length;
  if (totalBookings > 0) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'HAS_BOOKINGS',
          detail: `Cannot delete: customer has ${bookings.upcoming.length} upcoming and ${bookings.past.length} past bookings on file. Cancel or reassign first.`,
        },
        upcoming: bookings.upcoming.length,
        past: bookings.past.length,
      },
      { status: 409 },
    );
  }

  try {
    await deleteCustomer(customerId);
    // Defensive: if this customer was linked as someone's kid,
    // drop the link too. Without this the parent's Redis still
    // points at a now-deleted Square id, /my-bookings tries to
    // fetch bookings for a 404 customer and silently shows
    // nothing — same disappearing-act bug we fixed for Briar.
    try {
      const parentId = await getLinkedParent(customerId);
      if (parentId) {
        await unlinkPerson(parentId, customerId);
        logAdmin({ phase: 'customer-deleted-unlink', customerId, parentId });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown error';
      logAdmin({ phase: 'customer-deleted-unlink-failed', customerId, detail });
      // Non-fatal — the delete already succeeded.
    }
    logAdmin({
      phase: 'customer-deleted',
      customerId,
      email: existing.email_address,
    });
    return Response.json({ ok: true, customerId });
  } catch (err) {
    if (err instanceof SquareApiError) {
      logAdmin({
        phase: 'customer-delete-square-error',
        customerId,
        code: err.code,
        detail: err.detail,
      });
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail || 'Square rejected the delete.' } },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logAdmin({ phase: 'customer-delete-failed', customerId, detail });
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }
};
