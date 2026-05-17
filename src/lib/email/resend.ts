// Resend HTTP wrapper.
//
// We don't pull the SDK; native fetch is enough. Sender + reply-to
// live in env vars so flipping to a brand-aligned sending domain
// (e.g. mail.mdrnclassic.com once DNS verifies) is a Vercel env
// bump, not a redeploy. Brand-domain alignment matters for Gmail
// deliverability — from-domain mismatch ("bookings@designedtoelevate.co"
// for a Modern Classic email) is one of the top triggers for the
// spam folder.
//
//   RESEND_FROM_ADDRESS — full RFC 5322 "Name <email@domain>" line,
//                         e.g. "Modern Classic Barbershop <bookings@mail.mdrnclassic.com>"
//   RESEND_REPLY_TO     — bare email, e.g. "modernclassicbarbershop@protonmail.com"
//
// Both are required. Lazy-throw on first email send if either is
// missing — better to crash the cron loudly (visible in Vercel logs)
// than to silently fall back to a stale default and ship review
// emails from the wrong brand at 2am.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function readEnv(name: string): string | undefined {
  const fromMeta = (import.meta.env as Record<string, unknown>)[name];
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  const fromProc = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (typeof fromProc === 'string' && fromProc.length > 0) return fromProc;
  return undefined;
}

function getFromAddress(): string {
  const v = readEnv('RESEND_FROM_ADDRESS');
  if (!v) {
    throw new Error(
      'RESEND_FROM_ADDRESS is not set. Format: "Display Name <addr@domain>". Add it to .env (local) or Vercel env vars (deploy).',
    );
  }
  return v;
}

function getReplyTo(): string {
  const v = readEnv('RESEND_REPLY_TO');
  if (!v) {
    throw new Error(
      'RESEND_REPLY_TO is not set. Add a bare email address to .env (local) or Vercel env vars (deploy).',
    );
  }
  return v;
}

/**
 * Extract the bare email address from an RFC 5322 "Name <addr@domain>"
 * string, or return the input unchanged if no angle brackets are
 * present. Used by sendReviewRequest() to build a per-call From with
 * a personal display name while keeping the same address as the
 * global RESEND_FROM_ADDRESS.
 */
function parseAddressOnly(rfcAddress: string): string {
  const m = /<([^>]+)>/.exec(rfcAddress);
  return (m ? m[1] : rfcAddress).trim();
}

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
  /**
   * Optional per-call RFC 5322 From line. When set, overrides the
   * global RESEND_FROM_ADDRESS env var. Used by sendReviewRequest()
   * to personalize the sender as "{barberName} at Modern Classic"
   * — a deliverability win against Gmail's Promotions classifier,
   * which treats a generic shop From-name as a bulk-marketing
   * signal. Every other sender (sign-in code, booking confirmations,
   * waitlist, etc.) leaves this undefined and gets the global From.
   */
  from?: string;
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
  const body: Record<string, unknown> = {
    from: input.from ?? getFromAddress(),
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    reply_to: input.replyTo ?? getReplyTo(),
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

export interface SendAuthCodeInput {
  to: string;
  code: string;
  ttlMinutes: number;
  customerName?: string;
  shopPhone: string;
}

/**
 * Send the customer their 6-digit sign-in code. The link-free
 * counterpart to sendMagicLink — used when the customer's email
 * client opens links in a cookie-isolated in-app browser (the
 * iOS ProtonMail case). They read the code, swipe back to their
 * sign-in form, type it in. Cookie lands in the right jar.
 */
export async function sendAuthCode(input: SendAuthCodeInput): Promise<{ id: string }> {
  const { authCodeHtml, authCodeText, authCodeSubject } = await import('./templates/authCode');
  const html = authCodeHtml({
    code: input.code,
    customerName: input.customerName,
    ttlMinutes: input.ttlMinutes,
    shopPhone: input.shopPhone,
  });
  const text = authCodeText({
    code: input.code,
    customerName: input.customerName,
    ttlMinutes: input.ttlMinutes,
    shopPhone: input.shopPhone,
  });
  return sendEmail({
    to: input.to,
    subject: authCodeSubject(input.code),
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
  // Personal From-name override — "{barberName} at Modern Classic
  // <bookings@designedtoelevate.co>" instead of the global shop
  // display name. Reads as a 1:1 note from the barber, not a
  // shop-wide marketing blast. Falls back to the global address
  // when barberName is empty (defensive — the cron and test
  // endpoint both populate it from Square TeamMember.displayName).
  const trimmedBarber = (input.barberName ?? '').trim();
  const baseAddress = parseAddressOnly(getFromAddress());
  const personalFrom = trimmedBarber
    ? `${trimmedBarber} at Modern Classic <${baseAddress}>`
    : undefined;
  return sendEmail({
    to: input.to,
    subject: reviewRequestSubject({ customerName: input.customerName }),
    html,
    text,
    from: personalFrom,
    headers: {
      'List-Unsubscribe': `<mailto:${getReplyTo()}?subject=unsubscribe>, <${input.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}

export interface SendWaitlistConfirmationInput {
  to: string;
  customerName: string;
  serviceName: string;
  barberName: string;
  /** Optional pre-formatted "May 11 – May 18, 2026" string. Empty
   *  string / undefined → the window line is suppressed in the body. */
  windowLabel?: string;
  /** Optional time-of-day echo, e.g. "Mornings only" or "Within 30
   *  minutes of 3:00 PM or 5:30 PM". Suppressed when empty/undefined. */
  timePreferenceLabel?: string;
  shopAddress: string;
  shopPhone: string;
}

/**
 * Customer-facing thank-you the moment they submit the waitlist form.
 * Counterpart to the shop notification that already goes out via
 * sendWaitlistRequest. Reply-to is the shop inbox so a customer
 * tweaking their request goes straight to staff. No unsubscribe header
 * — this is transactional (the customer just took an action that
 * requested an email back), not marketing.
 */
export async function sendWaitlistConfirmation(
  input: SendWaitlistConfirmationInput,
): Promise<{ id: string }> {
  const { waitlistConfirmationHtml, waitlistConfirmationText, waitlistConfirmationSubject } =
    await import('./templates/waitlistConfirmation');
  const html = waitlistConfirmationHtml(input);
  const text = waitlistConfirmationText(input);
  return sendEmail({
    to: input.to,
    subject: waitlistConfirmationSubject(),
    html,
    text,
  });
}

export interface SendWaitlistBarberNotificationInput {
  to: string;
  barberDisplayName: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  windowLabel?: string;
  preferenceLabel?: string;
  note?: string;
  dashboardUrl: string;
  shopPhone: string;
}

/**
 * Fired alongside the shop + customer waitlist emails when the
 * customer specifically requested this barber. Reply-to goes to the
 * customer's own email so a quick reply from the barber's phone
 * threads straight to them.
 */
export async function sendWaitlistBarberNotification(
  input: SendWaitlistBarberNotificationInput,
): Promise<{ id: string }> {
  const {
    waitlistBarberNotificationHtml,
    waitlistBarberNotificationText,
    waitlistBarberNotificationSubject,
  } = await import('./templates/waitlistBarberNotification');
  const html = waitlistBarberNotificationHtml(input);
  const text = waitlistBarberNotificationText(input);
  return sendEmail({
    to: input.to,
    subject: waitlistBarberNotificationSubject({ customerName: input.customerName }),
    html,
    text,
    replyTo: input.customerEmail,
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
  });
}

export interface SendWaitlistSlotMatchBarberInput {
  to: string;
  barberDisplayName: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  whenLabel: string;
  dashboardUrl: string;
  shopPhone: string;
}

/**
 * Sister to sendWaitlistOpening. The cron sends this to the
 * specifically-requested barber when a customer's waitlist slot
 * matches an opening — so the barber is prepped before the customer
 * calls. Reply-to goes to the customer so a quick reply from the
 * barber's phone threads back to them.
 */
export async function sendWaitlistSlotMatchBarber(
  input: SendWaitlistSlotMatchBarberInput,
): Promise<{ id: string }> {
  const {
    waitlistSlotMatchBarberHtml,
    waitlistSlotMatchBarberText,
    waitlistSlotMatchBarberSubject,
  } = await import('./templates/waitlistSlotMatchBarber');
  const html = waitlistSlotMatchBarberHtml(input);
  const text = waitlistSlotMatchBarberText(input);
  return sendEmail({
    to: input.to,
    subject: waitlistSlotMatchBarberSubject({
      customerName: input.customerName,
      whenLabel: input.whenLabel,
    }),
    html,
    text,
    replyTo: input.customerEmail,
  });
}

export interface SendPasswordResetBarberInput {
  to: string;
  barberDisplayName: string;
  username: string;
  signInUrl: string;
  shopPhone: string;
}

/**
 * Security notification when an admin resets the barber's password.
 * Does NOT contain the new plaintext — Michael hands that over by
 * text. Reply-to is the shop inbox so the barber can flag an
 * unexpected reset.
 */
export async function sendPasswordResetBarber(
  input: SendPasswordResetBarberInput,
): Promise<{ id: string }> {
  const {
    passwordResetBarberHtml,
    passwordResetBarberText,
    passwordResetBarberSubject,
  } = await import('./templates/passwordResetBarber');
  const html = passwordResetBarberHtml(input);
  const text = passwordResetBarberText(input);
  return sendEmail({
    to: input.to,
    subject: passwordResetBarberSubject(),
    html,
    text,
  });
}

export interface SendNoShowChargeBarberInput {
  to: string;
  barberDisplayName: string;
  customerName: string;
  serviceName: string;
  whenLabel: string;
  amountCents: number;
  shopPhone: string;
}

/**
 * Fired after the no-show charge endpoint successfully captures the
 * card on file. Tells the assigned barber that the slot is lost AND
 * that the shop already collected.
 */
export async function sendNoShowChargeBarber(
  input: SendNoShowChargeBarberInput,
): Promise<{ id: string }> {
  const {
    noShowChargeBarberHtml,
    noShowChargeBarberText,
    noShowChargeBarberSubject,
  } = await import('./templates/noShowChargeBarber');
  const html = noShowChargeBarberHtml(input);
  const text = noShowChargeBarberText(input);
  return sendEmail({
    to: input.to,
    subject: noShowChargeBarberSubject({ customerName: input.customerName }),
    html,
    text,
  });
}

export interface SendReviewClickBarberInput {
  to: string;
  barberDisplayName: string;
  customerName: string;
  serviceName: string;
  appointmentDate: string;
  googleReviewUrl: string;
  shopPhone: string;
}

/**
 * Fired by /r/review.ts when a customer clicks through their review
 * request. Strong signal a review is incoming — the barber can watch
 * for it on Google and reply.
 */
export async function sendReviewClickBarber(
  input: SendReviewClickBarberInput,
): Promise<{ id: string }> {
  const {
    reviewClickBarberHtml,
    reviewClickBarberText,
    reviewClickBarberSubject,
  } = await import('./templates/reviewClickBarber');
  const html = reviewClickBarberHtml(input);
  const text = reviewClickBarberText(input);
  return sendEmail({
    to: input.to,
    subject: reviewClickBarberSubject({ customerName: input.customerName }),
    html,
    text,
  });
}

export interface SendFamilyInviteInput {
  /** Invitee's email (resolved from the customer record at invite time). */
  to: string;
  /** Display name of the inviter — "Bill", "Bill Chicha", whatever the
   *  caller resolved. Used verbatim in subject + body. */
  inviterName: string;
  /** Full /family/accept?token=... URL. */
  acceptUrl: string;
  /** Pre-formatted "in 7 days" / "by Sat May 18" copy. */
  expiresLabel: string;
  shopAddress: string;
  shopPhone: string;
}

/**
 * Family-account invite. Triggered when an existing customer invites
 * another adult to share their account. Reply-to is the shop inbox
 * so a confused invitee can ask the shop what this is. Transactional
 * (no unsubscribe header) — the invitee took an explicit action (a
 * trusted contact's request) that prompted this email.
 */
export async function sendFamilyInvite(
  input: SendFamilyInviteInput,
): Promise<{ id: string }> {
  const { familyInviteHtml, familyInviteText, familyInviteSubject } = await import(
    './templates/familyInvite'
  );
  const html = familyInviteHtml(input);
  const text = familyInviteText(input);
  return sendEmail({
    to: input.to,
    subject: familyInviteSubject({ inviterName: input.inviterName }),
    html,
    text,
  });
}

export interface SendFamilyInviteAcceptedInput {
  /** Inviter's email — the recipient of this notification. */
  to: string;
  /** Display name of the inviter, used in the body greeting. */
  inviterName: string;
  /** Display name of whoever just joined. */
  acceptedByName: string;
  /** Total members in the family AFTER the accept, for copy that
   *  says "you + N others" when more than two adults are involved. */
  totalMembers: number;
  /** Full URL to /my-bookings — the CTA in the email. */
  myBookingsUrl: string;
  shopAddress: string;
  shopPhone: string;
}

/**
 * "Your invite was accepted" notification. Sent to the original
 * inviter when the invitee taps Accept and the family-member record
 * is written. Best-effort from the caller's perspective — the accept
 * endpoint fires this without awaiting/blocking so a Resend hiccup
 * can't fail the accept itself.
 */
export async function sendFamilyInviteAccepted(
  input: SendFamilyInviteAcceptedInput,
): Promise<{ id: string }> {
  const {
    familyInviteAcceptedHtml,
    familyInviteAcceptedText,
    familyInviteAcceptedSubject,
  } = await import('./templates/familyInviteAccepted');
  const html = familyInviteAcceptedHtml(input);
  const text = familyInviteAcceptedText(input);
  return sendEmail({
    to: input.to,
    subject: familyInviteAcceptedSubject({ acceptedByName: input.acceptedByName }),
    html,
    text,
  });
}
