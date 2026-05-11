// Phase 7 — review-request email template.
//
// Branded HTML + a plaintext fallback. Inline CSS only (no <style>, no
// <link>) for maximum email-client compatibility (Gmail strips <style> in
// some contexts; Outlook is its own special hell). Single CTA button per
// the doc — never gate by sentiment, send everyone the same Google review
// link and trust customers to self-select.
//
// CAN-SPAM compliance lives in the footer: the shop's physical address +
// phone, the explicit unsubscribe link, and the reason they're getting
// the email. Resend additionally sets List-Unsubscribe via headers (see
// resend.ts).

export interface ReviewRequestProps {
  customerName: string;
  barberName: string;
  serviceName: string;
  /** Already-formatted local-time date string, e.g. "Friday, March 14". */
  appointmentDate: string;
  /** Click-tracking URL — wraps GOOGLE_REVIEW_URL via signClickToken. */
  googleReviewUrl: string;
  /** Per-customer signed unsubscribe URL. */
  unsubscribeUrl: string;
  /** Shop physical address — currently 819 Linden Avenue, Zanesville, OH 43701. */
  shopAddress: string;
  /** Shop phone for footer + reply-to fallback. */
  shopPhone: string;
}

const COLORS = {
  bg: '#f5efe4', // warm parchment — easier to read in inboxes than full dark
  card: '#ffffff',
  border: '#e6dccc',
  ink: '#1c1814',
  inkSoft: '#3d362c',
  muted: '#7a6f5f',
  gold: '#a07d30',
  goldLight: '#c9a35c',
  cardOnDark: '#1c1814',
  textOnGold: '#1c1814',
};

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
  const safeUrl = escapeHtml(props.googleReviewUrl);
  const unsub = escapeHtml(props.unsubscribeUrl);
  const barber = escapeHtml(props.barberName);
  const service = escapeHtml(props.serviceName);
  const when = escapeHtml(props.appointmentDate);
  const address = escapeHtml(props.shopAddress);
  const phone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>How was your visit?</title>
  </head>
  <body style="margin:0;padding:0;background:${COLORS.bg};color:${COLORS.ink};font-family:'Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.bg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:6px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 16px;text-align:center;border-bottom:1px solid ${COLORS.border};">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:0.02em;color:${COLORS.ink};">
                  Modern <span style="color:${COLORS.gold};">·</span> Classic
                </div>
                <div style="margin-top:6px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:${COLORS.muted};">
                  Barbershop &amp; Shave Parlor
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 4px;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${COLORS.ink};">Hello ${first},</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${COLORS.inkSoft};">
                  Thanks for stopping by Modern Classic on ${when} for your ${service} with ${barber}. Hope you walked out feeling sharp.
                </p>
                <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:${COLORS.inkSoft};">
                  If you've got a minute, would you mind leaving us a quick Google review? It genuinely helps a small local shop like ours, and we'd really appreciate it.
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
                  <tr>
                    <td align="center" style="background:${COLORS.gold};border-radius:3px;">
                      <a href="${safeUrl}" style="display:inline-block;padding:14px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#ffffff;text-decoration:none;">
                        Leave a Google Review
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLORS.muted};">
                  If something didn't go right, just reply to this email — we'd rather hear from you directly than read about it later.
                </p>
                <p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:${COLORS.ink};">
                  — Michael, Rick &amp; Clayton
                </p>
                <p style="margin:0 0 24px;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Modern Classic Barbershop
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px 24px;border-top:1px solid ${COLORS.border};text-align:center;">
                <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  ${address}<br />
                  ${phone}
                </p>
                <p style="margin:0;font-size:11px;line-height:1.6;color:${COLORS.muted};">
                  You're getting this one-time post-visit email because you booked an appointment with us.
                  Don't want these? <a href="${unsub}" style="color:${COLORS.gold};text-decoration:underline;">Turn off review requests</a>.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function reviewRequestText(props: ReviewRequestProps): string {
  const first = firstName(props.customerName);
  return `Hello ${first},

Thanks for stopping by Modern Classic on ${props.appointmentDate} for your ${props.serviceName} with ${props.barberName}. Hope you walked out feeling sharp.

If you've got a minute, would you mind leaving us a quick Google review? It genuinely helps a small local shop like ours, and we'd really appreciate it.

Leave a Google Review:
${props.googleReviewUrl}

If something didn't go right, just reply to this email — we'd rather hear from you directly than read about it later.

— Michael, Rick & Clayton
Modern Classic Barbershop

—
${props.shopAddress}
${props.shopPhone}

You're getting this one-time post-visit email because you booked an appointment with us. Don't want these? Turn off review requests: ${props.unsubscribeUrl}`;
}
