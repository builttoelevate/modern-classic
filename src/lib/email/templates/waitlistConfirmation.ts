// Customer-facing thank-you email sent the moment someone joins the
// waitlist via the form on the booking flow. Mirrors the parchment
// palette from waitlistOpening / reviewRequest so the conversation
// stays visually consistent — the customer first hears "we got you,
// we'll email when a slot opens" (this template), then later "an
// opening came up" (waitlistOpening).
//
// No CTA button by default. If we surfaced "browse current openings"
// here we'd cannibalize the more important confirmation message;
// customers who join the waitlist have already concluded that the
// times they want aren't on offer right now.

export interface WaitlistConfirmationProps {
  customerName: string;
  serviceName: string;
  barberName: string;
  /** Optional pre-formatted "May 11 – May 18, 2026" or single date.
   * Empty/undefined → the window line is suppressed. */
  windowLabel?: string;
  /** Shop physical address — currently 819 Linden Avenue, Zanesville, OH 43701. */
  shopAddress: string;
  /** Shop phone for footer. */
  shopPhone: string;
}

const COLORS = {
  bg: '#f5efe4',
  card: '#ffffff',
  border: '#e6dccc',
  ink: '#1c1814',
  inkSoft: '#3d362c',
  muted: '#7a6f5f',
  gold: '#a07d30',
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

export function waitlistConfirmationSubject(): string {
  return "You're on the waitlist — Modern Classic";
}

export function waitlistConfirmationHtml(props: WaitlistConfirmationProps): string {
  const first = escapeHtml(firstName(props.customerName));
  const service = escapeHtml(props.serviceName);
  const barber = escapeHtml(props.barberName);
  const windowLabel = props.windowLabel ? escapeHtml(props.windowLabel) : '';
  const address = escapeHtml(props.shopAddress);
  const phone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>You're on the waitlist at Modern Classic</title>
  </head>
  <body style="margin:0;padding:0;background:${COLORS.bg};color:${COLORS.ink};font-family:'Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.bg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:32px 36px 16px;text-align:center;border-bottom:1px solid ${COLORS.border};">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:0.02em;color:${COLORS.ink};">
                  Modern <span style="color:${COLORS.gold};">·</span> Classic
                </div>
                <div style="margin-top:6px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.muted};">
                  You're on the waitlist
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  Hi ${first} — thanks for joining the waitlist.
                </p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:${COLORS.inkSoft};">
                  We've got your request on file. <strong>We'll email you the moment a slot opens up</strong> that matches what you asked for.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;border:1px solid ${COLORS.border};border-radius:6px;background:${COLORS.bg};">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Service</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${service}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Barber</p>
                      <p style="margin:0${windowLabel ? ' 0 14px' : ''};font-size:16px;color:${COLORS.ink};">${barber}</p>
                      ${windowLabel ? `<p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">When you're available</p>
                      <p style="margin:0;font-size:16px;color:${COLORS.ink};">${windowLabel}</p>` : ''}
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 14px;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Openings are first-come, first-served — when your alert lands, the faster you book, the better the odds.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Need to change your request or have a question? Just reply to this email or call the shop at ${phone}.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 36px 26px;border-top:1px solid ${COLORS.border};text-align:center;">
                <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  You're getting this because you joined the waitlist on mdrnclassic.com.
                </p>
                <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  Modern Classic Barbershop &amp; Shave Parlor<br />
                  ${address} · ${phone}
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

export function waitlistConfirmationText(props: WaitlistConfirmationProps): string {
  const first = firstName(props.customerName);
  const lines = [
    `Hi ${first} — thanks for joining the waitlist.`,
    '',
    "We've got your request on file. We'll email you the moment a slot opens up that matches what you asked for.",
    '',
    `  Service: ${props.serviceName}`,
    `  Barber:  ${props.barberName}`,
  ];
  if (props.windowLabel) {
    lines.push(`  When:    ${props.windowLabel}`);
  }
  lines.push(
    '',
    'Openings are first-come, first-served — when your alert lands, the faster you book, the better the odds.',
    '',
    `Need to change your request or have a question? Just reply to this email or call the shop at ${props.shopPhone}.`,
    '',
    "You're getting this because you joined the waitlist on mdrnclassic.com.",
    '',
    '—',
    'Modern Classic Barbershop & Shave Parlor',
    props.shopAddress,
    props.shopPhone,
  );
  return lines.join('\n');
}
