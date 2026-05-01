import type { APIRoute } from 'astro';
import { sendWaitlistRequest } from '../../lib/email/resend';
import { redactEmail } from '../../lib/booking/log';

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
