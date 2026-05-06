// Phase 9 — admin one-tap "Email customer about this slot" from
// /admin/waitlist. Sends the same Resend "an opening just appeared"
// template that the cron uses, but for a specific slot the owner
// picked, then writes back lastNotifiedAt + notifiedSlotStartAtUtc so
// the next cron tick respects the 12h cooldown and per-slot dedup —
// preventing the cron from following up with a duplicate email.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  getWaitlistEntry,
  markWaitlistNotified,
  updateWaitlistStatus,
} from '../../../../lib/marketing/waitlistLog';
import { sendWaitlistOpening } from '../../../../lib/email/resend';
import { formatRelativeSlot } from '../../../../lib/availability/timing';
import { redactEmail } from '../../../../lib/booking/log';

export const prerender = false;

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';

interface NotifyBody {
  entryId: string;
  startAtUtc: string;
  serviceVariationId?: string;
  teamMemberId?: string;
}

function fail(code: string, detail: string, status: number): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function validate(body: unknown): NotifyBody | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object.';
  const b = body as Record<string, unknown>;
  const entryId = typeof b.entryId === 'string' ? b.entryId.trim() : '';
  const startAtUtc = typeof b.startAtUtc === 'string' ? b.startAtUtc.trim() : '';
  const serviceVariationId =
    typeof b.serviceVariationId === 'string' ? b.serviceVariationId.trim() : undefined;
  const teamMemberId =
    typeof b.teamMemberId === 'string' ? b.teamMemberId.trim() : undefined;

  if (!entryId) return 'entryId is required.';
  if (!startAtUtc) return 'startAtUtc is required.';
  if (Number.isNaN(Date.parse(startAtUtc))) return 'startAtUtc must be a valid ISO date.';

  return { entryId, startAtUtc, serviceVariationId, teamMemberId };
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('BAD_REQUEST', 'Body must be valid JSON.', 400);
  }
  const v = validate(raw);
  if (typeof v === 'string') return fail('BAD_REQUEST', v, 400);
  const { entryId, startAtUtc, serviceVariationId, teamMemberId } = v;

  let entry;
  try {
    entry = await getWaitlistEntry(entryId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({ phase: 'waitlist-notify-lookup-failed', entryId, detail });
    return fail('INTERNAL', detail, 500);
  }
  if (!entry) return fail('NOT_FOUND', 'No waitlist entry with that id.', 404);
  if (!entry.customerEmail || !entry.customerEmail.trim()) {
    return fail('NO_EMAIL', 'This waitlist entry has no email on file.', 400);
  }

  // Build the deep-link the same way the cron does: pre-fill service +
  // barber so the customer lands on Step 3 with the date picker open.
  // Prefer the values from the request body (the slot the admin clicked
  // may differ from entry defaults — e.g. a specific barber when the
  // entry was "any"), fall back to the entry's stored values.
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const svid = serviceVariationId ?? entry.serviceVariationId ?? '';
  const tmid = teamMemberId ?? entry.teamMemberId ?? '';
  if (svid) params.set('service', svid);
  if (tmid) params.set('barber', tmid);
  const bookUrl = `${url.origin}/book${params.toString() ? `?${params.toString()}` : ''}`;

  const whenLabel = formatRelativeSlot(startAtUtc);

  let resendId: string;
  try {
    const result = await sendWaitlistOpening({
      to: entry.customerEmail,
      customerName: entry.customerName,
      barberName: entry.barberName,
      serviceName: entry.serviceName,
      whenLabel,
      bookUrl,
      shopAddress: SHOP_ADDRESS,
      shopPhone: SHOP_PHONE,
    });
    resendId = result.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({
      phase: 'waitlist-notify-send-failed',
      entryId,
      email: redactEmail(entry.customerEmail),
      detail,
    });
    return fail(
      'EMAIL_FAILED',
      "We couldn't send the email — check Resend logs and try again.",
      502,
    );
  }

  // Mark notified so the cron's 12h cooldown + per-slot dedup picks
  // this up on its next tick. KV write failure here is non-fatal — the
  // email already went out.
  try {
    await markWaitlistNotified(entryId, startAtUtc);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({
      phase: 'waitlist-notify-mark-failed',
      entryId,
      resendId,
      detail,
    });
  }

  // Promote to 'contacted' if still 'new'. Don't downgrade — if the
  // entry was already booked or archived, leave it alone.
  if (entry.status === 'new') {
    try {
      await updateWaitlistStatus({ id: entryId, status: 'contacted' });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logAdmin({
        phase: 'waitlist-notify-status-write-failed',
        entryId,
        resendId,
        detail,
      });
    }
  }

  logAdmin({
    phase: 'waitlist-notify-sent',
    entryId,
    email: redactEmail(entry.customerEmail),
    startAtUtc,
    resendId,
  });
  return Response.json({ ok: true, resendId });
};
