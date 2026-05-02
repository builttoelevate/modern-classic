// Phase 5 Part A — Resend HTTP wrapper.
//
// We don't pull the SDK; native fetch is enough. Sender domain is
// designedtoelevate.co (already verified on the Resend account). Reply-to
// goes to the shop's protonmail (per SQUARE_REFERENCE.md §2).

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const FROM_DISPLAY = 'Modern Classic Barbershop';
const FROM_ADDRESS = 'bookings@designedtoelevate.co';
const REPLY_TO = 'modernclassicbarbershop@protonmail.com';

export class ResendApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ResendApiError';
    this.status = status;
    this.body = body;
  }
}

function getApiKey(): string {
  if (typeof window !== 'undefined') {
    throw new Error('Resend API key is server-only — refusing to read in browser context.');
  }
  const key = import.meta.env.RESEND_API_KEY;
  if (!key || typeof key !== 'string') {
    throw new Error('RESEND_API_KEY is not set. Add it to .env (local) or Vercel env vars (deploy).');
  }
  return key;
}

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  fromDisplay?: string;
  /**
   * Custom RFC 5322 headers. We use this for List-Unsubscribe /
   * List-Unsubscribe-Post (Gmail bulk-sender requirements + RFC 8058
   * one-click unsubscribe).
   */
  headers?: Record<string, string>;
}

interface ResendResponse {
  id?: string;
}

async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const key = getApiKey();
  const fromDisplay = input.fromDisplay ?? FROM_DISPLAY;
  const body: Record<string, unknown> = {
    from: `${fromDisplay} <${FROM_ADDRESS}>`,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    reply_to: input.replyTo ?? REPLY_TO,
  };
  if (input.headers && Object.keys(input.headers).length > 0) {
    body.headers = input.headers;
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new ResendApiError(
      `Resend POST /emails → ${res.status}`,
      res.status,
      text.slice(0, 1000),
    );
  }
  let parsed: ResendResponse;
  try {
    parsed = JSON.parse(text) as ResendResponse;
  } catch {
    throw new ResendApiError('Resend returned non-JSON success', res.status, text.slice(0, 1000));
  }
  if (!parsed.id || typeof parsed.id !== 'string') {
    throw new ResendApiError('Resend response missing id', res.status, text.slice(0, 1000));
  }
  return { id: parsed.id };
}

export interface SendMagicLinkInput {
  to: string;
  magicUrl: string;
  customerName?: string;
}

export async function sendMagicLink(input: SendMagicLinkInput): Promise<{ id: string }> {
  // Lazy import keeps this module from forcing the templates module into
  // any caller's bundle if it's just probing.
  const { magicLinkHtml, magicLinkText } = await import('./templates');
  const html = magicLinkHtml({ magicUrl: input.magicUrl, customerName: input.customerName });
  const text = magicLinkText({ magicUrl: input.magicUrl, customerName: input.customerName });
  return sendEmail({
    to: input.to,
    subject: 'Your Modern Classic sign-in link',
    html,
    text,
  });
}

export interface SendWaitlistInput {
  to: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  barberName: string;
  preferredDate?: string;
  note?: string;
  submittedAt: string;
}

export async function sendWaitlistRequest(input: SendWaitlistInput): Promise<{ id: string }> {
  const { waitlistRequestHtml, waitlistRequestText } = await import('./templates');
  const html = waitlistRequestHtml(input);
  const text = waitlistRequestText(input);
  return sendEmail({
    to: input.to,
    subject: `Waitlist request — ${input.customerName} (${input.serviceName} with ${input.barberName})`,
    html,
    text,
    replyTo: input.customerEmail,
  });
}

export interface SendReviewRequestInput {
  to: string;
  customerName: string;
  barberName: string;
  serviceName: string;
  appointmentDate: string;
  googleReviewUrl: string;
  unsubscribeUrl: string;
  shopAddress: string;
  shopPhone: string;
}

/**
 * Phase 7 — automated review-request email.
 *
 * Adds the bulk-sender headers required by Gmail (RFC 8058 one-click):
 *   - List-Unsubscribe: <mailto:>, <https://...>
 *   - List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The mailto: + https: pair is the recommended format. Gmail and Apple
 * Mail render a "Unsubscribe" button next to the sender name in the
 * inbox UI when these are present and the URL responds 200 to a POST.
 */
export async function sendReviewRequest(
  input: SendReviewRequestInput,
): Promise<{ id: string }> {
  const { reviewRequestHtml, reviewRequestText, reviewRequestSubject } = await import(
    './templates/reviewRequest'
  );
  const html = reviewRequestHtml(input);
  const text = reviewRequestText(input);
  return sendEmail({
    to: input.to,
    subject: reviewRequestSubject({ customerName: input.customerName }),
    html,
    text,
    replyTo: REPLY_TO,
    headers: {
      'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${input.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}

export interface SendWaitlistOpeningInput {
  to: string;
  customerName: string;
  barberName: string;
  serviceName: string;
  whenLabel: string;
  bookUrl: string;
  shopAddress: string;
  shopPhone: string;
}

/**
 * Phase 8 — fired by /api/cron/waitlist-notify the moment a slot
 * matching a customer's waitlist preferences appears on Square. Reply-to
 * goes to the shop inbox so a customer can reply to confirm or ask
 * questions; the customer themselves is in the To: header. No
 * unsubscribe header — these are transactional (the customer asked us
 * to email them about openings), not marketing.
 */
export async function sendWaitlistOpening(
  input: SendWaitlistOpeningInput,
): Promise<{ id: string }> {
  const { waitlistOpeningHtml, waitlistOpeningText, waitlistOpeningSubject } = await import(
    './templates/waitlistOpening'
  );
  const html = waitlistOpeningHtml(input);
  const text = waitlistOpeningText(input);
  return sendEmail({
    to: input.to,
    subject: waitlistOpeningSubject({
      whenLabel: input.whenLabel,
      barberName: input.barberName,
    }),
    html,
    text,
    replyTo: REPLY_TO,
  });
}
