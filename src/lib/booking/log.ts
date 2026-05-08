// Server-side logging for the booking flow. Phase 4 D.1 — structured JSON
// to Vercel function logs, with PII redacted.

export type BookingPhase =
  | 'request-received'
  | 'find-or-create-customer'
  | 'use-existing-customer'
  | 'use-session-customer'
  | 'session-customer-missing-fallback'
  | 'existing-customer-forbidden'
  | 'create-booking'
  | 'success'
  | 'validation-failed'
  | 'square-error'
  | 'unexpected-error'
  | 'marketing-consent';

interface LogPayload {
  phase: BookingPhase;
  customerEmail?: string;
  customerInitials?: string;
  service?: string;
  startAtUtc?: string;
  bookingId?: string;
  customerId?: string;
  errorCode?: string;
  errorDetail?: string;
  durationMs?: number;
  attemptId?: string;
  marketingConsent?: boolean;
  marketingDecision?: string;
}

export function redactEmail(email: string | undefined): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain || !local) return '***';
  const head = local.slice(0, 1);
  const stars = local.length > 1 ? '***' : '';
  return `${head}${stars}@${domain}`;
}

export function customerInitials(givenName: string, familyName: string): string {
  const g = (givenName ?? '').trim()[0]?.toUpperCase() ?? '?';
  const f = (familyName ?? '').trim()[0]?.toUpperCase() ?? '?';
  return `${g}.${f}.`;
}

export function logBooking(payload: LogPayload): void {
  // Vercel parses console.log lines with a leading [BOOK] tag; structured
  // JSON makes downstream filtering easy.
  // eslint-disable-next-line no-console
  console.log(
    `[BOOK] ${JSON.stringify({
      ts: new Date().toISOString(),
      ...payload,
    })}`,
  );
}
