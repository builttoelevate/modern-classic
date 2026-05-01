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
}

interface ResendResponse {
  id?: string;
}

async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const key = getApiKey();
  const fromDisplay = input.fromDisplay ?? FROM_DISPLAY;
  const body = {
    from: `${fromDisplay} <${FROM_ADDRESS}>`,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    reply_to: input.replyTo ?? REPLY_TO,
  };

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
