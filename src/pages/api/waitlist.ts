import type { APIRoute } from 'astro';
import {
  sendWaitlistBarberNotification,
  sendWaitlistConfirmation,
  sendWaitlistRequest,
} from '../../lib/email/resend';
import { redactEmail } from '../../lib/booking/log';
import { recordWaitlistEntry } from '../../lib/marketing/waitlistLog';
import { resolveBarberContacts } from '../../lib/barber/contactLookup';
import { getPublicOrigin } from '../../lib/utils/origin';

export const prerender = false;

const SHOP_INBOX = 'modernclassicbarbershop@protonmail.com';
const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';

// Pretty-print [dateFrom, dateTo] for the customer's thank-you email.
// Both YYYY-MM-DD strings (validated upstream). Returns empty when
// neither end is set so the template can suppress the line entirely.
function formatWindow(dateFrom: string | undefined, dateTo: string | undefined): string {
  if (!dateFrom && !dateTo) return '';
  const fmt = (iso: string): string =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${iso}T12:00:00`));
  if (dateFrom && dateTo) {
    return dateFrom === dateTo ? fmt(dateFrom) : `${fmt(dateFrom)} – ${fmt(dateTo)}`;
  }
  if (dateFrom) return `From ${fmt(dateFrom)}`;
  if (dateTo) return `Through ${fmt(dateTo)}`;
  return '';
}
// Summarize day-of-week + time-of-day chips into a single human line
// for the barber notification email ("Mon, Tue, Wed · afternoon").
// Returns empty when neither field has anything actionable.
function buildPreferenceLabel(
  days: string[] | undefined,
  times: string[] | undefined,
): string {
  const dayLabels: Record<string, string> = {
    mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat',
  };
  const timeLabels: Record<string, string> = {
    morning: 'morning', afternoon: 'afternoon', evening: 'evening',
  };
  const d = (days ?? []).map((k) => dayLabels[k]).filter(Boolean);
  const t = (times ?? []).map((k) => timeLabels[k]).filter(Boolean);
  const parts: string[] = [];
  if (d.length > 0) parts.push(d.join(', '));
  if (t.length > 0) parts.push(t.join(', '));
  return parts.join(' · ');
}

/** Customer-facing echo for the confirmation email. Pretty-prints the
 *  selected time preference — band list, single-time, multi-time —
 *  with strictness suffix when meaningful. Returns empty when the
 *  customer made no time selection. */
function buildTimePreferenceLabel(
  timesOfDay: string[] | undefined,
  exactTimes: string[] | undefined,
  exactMode: 'exact' | 'loose' | undefined,
): string {
  if (exactTimes && exactTimes.length > 0) {
    const fmt12 = (hhmm: string): string => {
      const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
      if (!m) return hhmm;
      const h = Number(m[1]);
      const min = m[2];
      const period = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${h12}:${min} ${period}`;
    };
    const pretty = exactTimes.map(fmt12);
    const joined =
      pretty.length === 1
        ? pretty[0]
        : pretty.length === 2
          ? `${pretty[0]} or ${pretty[1]}`
          : `${pretty.slice(0, -1).join(', ')}, or ${pretty[pretty.length - 1]}`;
    return exactMode === 'exact'
      ? `Exactly at ${joined}`
      : `Within 30 minutes of ${joined}`;
  }
  if (timesOfDay && timesOfDay.length > 0 && timesOfDay.length < 3) {
    const bandPretty: Record<string, string> = {
      morning: 'Mornings',
      afternoon: 'Afternoons',
      evening: 'Evenings',
    };
    const labels = timesOfDay.map((k) => bandPretty[k] ?? k).filter(Boolean);
    if (labels.length === 1) return `${labels[0]} only`;
    if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
    return labels.join(', ');
  }
  return '';
}

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

  // Multi-pick: customer chose 1+ barbers from the new checkbox group.
  // Empty / absent = "any barber". Capped at the active roster size to
  // bound payload growth + KV entry size if anything weird is posted.
  const MAX_BARBER_PICKS = 16;
  const teamMemberIdsRaw = Array.isArray(b.teamMemberIds) ? b.teamMemberIds : [];
  const barberDisplayNamesRaw = Array.isArray(b.barberDisplayNames) ? b.barberDisplayNames : [];
  const teamMemberIds: string[] = [];
  const barberDisplayNames: string[] = [];
  for (let i = 0; i < teamMemberIdsRaw.length && teamMemberIds.length < MAX_BARBER_PICKS; i++) {
    const id = teamMemberIdsRaw[i];
    if (typeof id !== 'string' || !id.trim()) continue;
    const trimmedId = id.trim().slice(0, 64);
    if (teamMemberIds.includes(trimmedId)) continue;
    const name = barberDisplayNamesRaw[i];
    teamMemberIds.push(trimmedId);
    barberDisplayNames.push(
      typeof name === 'string' && name.trim()
        ? name.trim().slice(0, FIELD_LIMITS.barberName)
        : barberName,
    );
  }

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
  const timesOfDayCandidate = Array.isArray(b.timesOfDay)
    ? Array.from(
        new Set(
          b.timesOfDay.filter(
            (t): t is string => typeof t === 'string' && ALLOWED_TIMES.has(t),
          ),
        ),
      )
    : undefined;

  // Specific-times mode — mutually exclusive with timesOfDay above.
  // The form lets the customer pick one mode at a time; the API
  // rejects payloads that send both populated.
  const EXACT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const EXACT_TIMES_MAX = 5;
  const exactTimesCandidate = Array.isArray(b.exactTimes)
    ? Array.from(
        new Set(
          b.exactTimes.filter(
            (t): t is string => typeof t === 'string' && EXACT_TIME_RE.test(t),
          ),
        ),
      ).slice(0, EXACT_TIMES_MAX)
    : undefined;
  const exactTimesMatchModeCandidate: 'exact' | 'loose' | undefined =
    b.exactTimesMatchMode === 'exact'
      ? 'exact'
      : b.exactTimesMatchMode === 'loose'
        ? 'loose'
        : undefined;

  const hasTimesOfDay = !!(timesOfDayCandidate && timesOfDayCandidate.length > 0);
  const hasExactTimes = !!(exactTimesCandidate && exactTimesCandidate.length > 0);
  if (hasTimesOfDay && hasExactTimes) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          detail:
            'Pick one time-of-day mode — either parts of the day (Morning / Afternoon / Evening) OR specific times, not both.',
        },
      },
      { status: 400 },
    );
  }

  // Resolve the final stored values: when exactTimes is the active
  // mode, timesOfDay is dropped; mode metadata is only persisted when
  // exactTimes is non-empty.
  const timesOfDay = hasExactTimes ? undefined : timesOfDayCandidate;
  const exactTimes = hasExactTimes ? exactTimesCandidate : undefined;
  const exactTimesMatchMode = hasExactTimes ? exactTimesMatchModeCandidate : undefined;

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
        teamMemberIds: teamMemberIds.length > 0 ? teamMemberIds : undefined,
        barberDisplayNames: teamMemberIds.length > 0 ? barberDisplayNames : undefined,
        preferredDate,
        note,
        dateFrom,
        dateTo,
        daysOfWeek,
        timesOfDay,
        exactTimes,
        exactTimesMatchMode,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logWaitlist({ phase: 'kv-write-failed', email: redactEmail(email), detail });
    }

    // Customer thank-you. Non-fatal — the shop already has the request
    // (email sent above + KV record), and the form has its own success
    // state, so a missing acknowledgment email shouldn't surface as an
    // error to the customer.
    const windowLabel = formatWindow(dateFrom, dateTo);
    const timePreferenceLabel = buildTimePreferenceLabel(
      timesOfDay,
      exactTimes,
      exactTimesMatchMode,
    );
    try {
      const confirmResult = await sendWaitlistConfirmation({
        to: email,
        customerName: name,
        serviceName,
        barberName,
        windowLabel,
        timePreferenceLabel: timePreferenceLabel || undefined,
        shopAddress: SHOP_ADDRESS,
        shopPhone: SHOP_PHONE,
      });
      logWaitlist({
        phase: 'confirmation-sent',
        email: redactEmail(email),
        messageId: confirmResult.id,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logWaitlist({ phase: 'confirmation-send-failed', email: redactEmail(email), detail });
    }

    // Barber notification — fired when the customer specifically named
    // one or more barbers on the form. Each requested barber gets their
    // own email (with customer phone / email surfaced for quick text or
    // call back). "Any barber" entries don't trigger this — they're
    // generic and would spam every barber's inbox on every submit.
    //
    // Email resolution: barber's own account-store email wins; if unset
    // we fall back to Square's TeamMember.email_address. If neither is
    // present, we skip that barber silently. Failures are logged but
    // never fatal — the shop already has the request and the customer
    // already got their confirmation.
    const requestedIds = teamMemberIds.length > 0
      ? teamMemberIds
      : teamMemberId
        ? [teamMemberId]
        : [];
    if (requestedIds.length > 0) {
      try {
        const baseUrl = getPublicOrigin(request);
        const dashboardUrl = `${baseUrl}/barber/dashboard?tab=waitlist`;
        const preferenceLabel = buildPreferenceLabel(daysOfWeek, timesOfDay);
        const contacts = await resolveBarberContacts(requestedIds);
        const sentTo = new Set<string>();
        await Promise.all(
          requestedIds.map(async (id, i) => {
            const contact = contacts.get(id);
            if (!contact) {
              logWaitlist({ phase: 'barber-notify-skipped-no-email', teamMemberId: id });
              return;
            }
            if (sentTo.has(contact.email)) return; // de-dup duplicate inboxes
            sentTo.add(contact.email);
            const displayName = barberDisplayNames[i] || contact.displayName || barberName;
            try {
              const r = await sendWaitlistBarberNotification({
                to: contact.email,
                barberDisplayName: displayName,
                customerName: name,
                customerEmail: email,
                customerPhone: phone,
                serviceName,
                windowLabel,
                preferenceLabel,
                note,
                dashboardUrl,
                shopPhone: SHOP_PHONE,
              });
              logWaitlist({
                phase: 'barber-notify-sent',
                teamMemberId: id,
                inbox: redactEmail(contact.email),
                messageId: r.id,
              });
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              logWaitlist({
                phase: 'barber-notify-failed',
                teamMemberId: id,
                inbox: redactEmail(contact.email),
                detail,
              });
            }
          }),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logWaitlist({ phase: 'barber-notify-resolve-failed', detail });
      }
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
          detail: "We couldn't submit your request right now. Please email modernclassicbarbershop@protonmail.com.",
        },
      },
      { status: 502 },
    );
  }
};
