// Review-request email — deliverability rewrite (May 2026).
//
// Why this looks the way it does:
//
// The previous version was a branded HTML email — parchment background,
// white card, gold uppercase CTA button, CAN-SPAM footer block. Gmail's
// Promotions classifier read every one of those as marketing-bulk
// signals and routed the email to the Promotions tab. The 6-digit
// sign-in code email (same Resend account, same sender) lands in
// Primary because it's minimal and looks transactional.
//
// This rewrite drops every visual marketing signal: no <table>
// scaffolding, no card, no header wordmark, no styled CTA button,
// no footer address block. The goal is a 1:1-looking note from the
// barber who served the appointment — black text on white, system
// fonts, inline text link, conversational copy.
//
// Kept (intentionally):
//   - HTML-escape every interpolated value (XSS hygiene + email
//     clients render entity-escaped reliably).
//   - A tiny lowercase "unsubscribe" link at the very bottom. The
//     accompanying List-Unsubscribe header is still set in
//     sendReviewRequest() in resend.ts — Gmail's bulk-sender
//     guidelines treat a *missing* header as a stronger negative
//     signal than a present one for senders it's already learned to
//     route as bulk. Belt-and-suspenders.
//
// The personal From-name ("{barberName} at Modern Classic <...>")
// lives in resend.ts:sendReviewRequest(), not here — this template
// owns the body only.

export interface ReviewRequestProps {
  customerName: string;
  barberName: string;
  /** Kept on the interface for API compatibility — the new template
   *  doesn't surface the service name (it reads templated). The cron
   *  still passes it; we just ignore it. */
  serviceName: string;
  /** Already-formatted local-time date — should be a single
   *  conversational token like "Thursday" (the cron's window is
   *  2-5 days back, so day-of-week is unambiguous). Avoid full dates
   *  like "Thursday, May 14, 2026" — reads as a templated mail-merge. */
  appointmentDate: string;
  /** Click-tracking URL — wraps GOOGLE_REVIEW_URL via signClickToken. */
  googleReviewUrl: string;
  /** Per-customer signed unsubscribe URL. */
  unsubscribeUrl: string;
  /** Shop address — kept on the interface for backwards compatibility
   *  with the cron's call shape. Not rendered in the new body. */
  shopAddress: string;
  /** Shop phone — same, not rendered. */
  shopPhone: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(full: string): string {
  const trimmed = (full ?? '').trim();
  if (!trimmed) return 'friend';
  const space = trimmed.indexOf(' ');
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

export function reviewRequestSubject(props: Pick<ReviewRequestProps, 'customerName'>): string {
  return `How was your visit, ${firstName(props.customerName)}?`;
}

export function reviewRequestHtml(props: ReviewRequestProps): string {
  const first = escapeHtml(firstName(props.customerName));
  const barber = escapeHtml(props.barberName?.trim() || 'one of the team');
  const when = escapeHtml(props.appointmentDate);
  const safeUrl = escapeHtml(props.googleReviewUrl);
  const unsub = escapeHtml(props.unsubscribeUrl);

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px 16px;background:#ffffff;color:#222;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.55;">
    <p style="margin:0 0 16px;">Hey ${first} — ${barber} here.</p>
    <p style="margin:0 0 16px;">Thanks for coming in ${when}. If you've got a sec, a quick Google review would mean a lot to the shop:</p>
    <p style="margin:0 0 16px;"><a href="${safeUrl}" style="color:#1a73e8;">leave a quick review</a></p>
    <p style="margin:0 0 16px;">If something didn't go right, just hit reply — I'd rather hear from you directly.</p>
    <p style="margin:24px 0 0;">— ${barber}</p>
    <p style="margin:48px 0 0;font-size:11px;color:#888;"><a href="${unsub}" style="color:#888;text-decoration:underline;">unsubscribe</a></p>
  </body>
</html>`;
}

export function reviewRequestText(props: ReviewRequestProps): string {
  const first = firstName(props.customerName);
  const barber = (props.barberName ?? '').trim() || 'one of the team';
  return `Hey ${first} — ${barber} here.

Thanks for coming in ${props.appointmentDate}. If you've got a sec, a quick Google review would mean a lot to the shop:

${props.googleReviewUrl}

If something didn't go right, just hit reply — I'd rather hear from you directly.

— ${barber}

unsubscribe: ${props.unsubscribeUrl}`;
}
