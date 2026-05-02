import type { APIRoute } from 'astro';
import { sendWaitlistRequest } from '../../lib/email/resend';
import { redactEmail } from '../../lib/booking/log';
import { recordWaitlistEntry } from '../../lib/marketing/waitlistLog';

export const prerender = false;

const SHOP_INBOX = 'modernclassicbarbershop@protonmail.com';
const RATE_LIMIT_SECONDS = 60;
const lastSubmittedAt = new Map<string, number>();

const FIELD_LIMITS = {
  name: 80,
  email: 120,
  phone: 32,
  serviceName: 80,
  barberName: 60,
  preferredDate: 64,
  note: 600,
};

function pruneRateLimit(now: number): void {
  if (lastSubmittedAt.size < 1024) return;
  for (const [k, ts] of lastSubmittedAt) {
    if (now - ts > RATE_LIMIT_SECONDS * 1000) lastSubmittedAt.delete(k);
  }
}

function isString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isValidEmail(s: string): boolean {
  return /^\S+@\S+\.\S+$/.test(s.trim());
}

function isValidPhone(s: string): boolean {
  // Strip everything but digits + leading '+'. Accept 7+ digits.
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 16;
}

function logWaitlist(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[WAITLIST] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
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
  const name = isString(b.name, FIELD_LIMITS.name) ? b.name.trim() : '';
  const email = isString(b.email, FIELD_LIMITS.email) ? b.email.trim() : '';
  const phone = isString(b.phone, FIELD_LIMITS.phone) ? b.phone.trim() : '';
  const serviceName = isString(b.serviceName, FIELD_LIMITS.serviceName) ? b.serviceName.trim() : '';
  const barberName = isString(b.barberName, FIELD_LIMITS.barberName) ? b.barberName.trim() : '';
  const preferredDate =
    isString(b.preferredDate, FIELD_LIMITS.preferredDate) ? b.preferredDate.trim() : undefined;
  const note = isString(b.note, FIELD_LIMITS.note) ? b.note.trim() : undefined;
  // Optional Square IDs the client passes through so admin can deep-link
  // straight into /book?service=...&barber=... when scheduling. Either
  // can be null if the client didn't have one (e.g. "Any barber" path
  // hands over no teamMemberId).
  const serviceVariationId = typeof b.serviceVariationId === 'string' && b.serviceVariationId.trim()
    ? b.serviceVariationId.trim().slice(0, 64)
    : null;
  const teamMemberId = typeof b.teamMemberId === 'string' && b.teamMemberId.trim()
    ? b.teamMemberId.trim().slice(0, 64)
    : null;

  // Phase 8 — auto-notify preferences. Validated as a strict YYYY-MM-DD
  // ISO date and a small allow-list of chip keys. All optional so the
  // older clients that don't send them still work.
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const dateFrom = typeof b.dateFrom === 'string' && ISO_DATE.test(b.dateFrom)
    ? b.dateFrom
    : undefined;
  const dateTo = typeof b.dateTo === 'string' && ISO_DATE.test(b.dateTo)
    ? b.dateTo
    : undefined;
  if (dateFrom && dateTo && dateTo < dateFrom) {
    return Response.json(
      {
        ok: false,
        error: { code: 'BAD_REQUEST', detail: '"To" date can\'t be before "From" date.' },
      },
      { status: 400 },
    );
  }
  const ALLOWED_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  const ALLOWED_TIMES = new Set(['morning', 'afternoon', 'evening']);
  const daysOfWeek = Array.isArray(b.daysOfWeek)
    ? Array.from(
        new Set(
          b.daysOfWeek.filter(
            (d): d is string => typeof d === 'string' && ALLOWED_DAYS.has(d),
          ),
        ),
      )
    : undefined;
  const timesOfDay = Array.isArray(b.timesOfDay)
    ? Array.from(
        new Set(
          b.timesOfDay.filter(
            (t): t is string => typeof t === 'string' && ALLOWED_TIMES.has(t),
          ),
        ),
      )
    : undefined;

  if (!name || !email || !phone || !serviceName || !barberName) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          detail: 'Name, email, phone, service, and barber are all required.',
        },
      },
      { status: 400 },
    );
  }
  if (!isValidEmail(email)) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'A valid email is required.' } },
      { status: 400 },
    );
  }
  if (!isValidPhone(phone)) {
    return Response.json(
      { ok: false, error: { code: 'BAD_REQUEST', detail: 'A valid phone number is required.' } },
      { status: 400 },
    );
  }

  const rateKey = `${email.toLowerCase()}|${clientAddress ?? 'unknown'}`;
  const now = Date.now();
  const last = lastSubmittedAt.get(rateKey);
  if (last && now - last < RATE_LIMIT_SECONDS * 1000) {
    const retryAfter = Math.ceil((RATE_LIMIT_SECONDS * 1000 - (now - last)) / 1000);
    return Response.json(
      {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          detail: `Please wait ${retryAfter}s before submitting again.`,
        },
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }
  lastSubmittedAt.set(rateKey, now);
  pruneRateLimit(now);

  const submittedAt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(new Date());

  try {
    const result = await sendWaitlistRequest({
      to: SHOP_INBOX,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      serviceName,
      barberName,
      preferredDate,
      note,
      submittedAt,
    });
    logWaitlist({
      phase: 'sent',
      email: redactEmail(email),
      service: serviceName,
      barber: barberName,
      messageId: result.id,
    });

    // Persist to KV so /admin/waitlist has a system of record beyond
    // the shop's email inbox. KV failure is non-fatal — the email
    // already went out and is the primary notification path.
    try {
      await recordWaitlistEntry({
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        serviceName,
        barberName,
        serviceVariationId,
        teamMemberId,
        preferredDate,
        note,
        dateFrom,
        dateTo,
        daysOfWeek,
        timesOfDay,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logWaitlist({ phase: 'kv-write-failed', email: redactEmail(email), detail });
    }
    return Response.json({ ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logWaitlist({ phase: 'send-failed', email: redactEmail(email), detail });
    return Response.json(
      {
        ok: false,
        error: {
          code: 'EMAIL_FAILED',
          detail: "We couldn't submit your request right now. Please call 740-297-4462.",
        },
      },
      { status: 502 },
    );
  }
};
