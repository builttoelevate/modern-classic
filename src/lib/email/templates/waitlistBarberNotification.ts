// Barber-facing notification when a customer joins the waitlist and
// specifically requested THIS barber. Mirrors the parchment palette of
// the customer confirmation so the look stays consistent, but the
// framing is for an internal recipient: customer details up front,
// strong call to text/call them.

export interface WaitlistBarberNotificationProps {
  barberDisplayName: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  /** Optional pre-formatted "May 11 – May 18, 2026" or single date.
   *  Empty/undefined → the window line is suppressed. */
  windowLabel?: string;
  /** Optional preference summary (e.g. "Mon, Tue, Wed · afternoon"). */
  preferenceLabel?: string;
  /** Optional free-text the customer left on the form. */
  note?: string;
  /** Where to deep-link the barber so one tap lands them on their
   *  waitlist tab. e.g. https://modernclassicbarbershop.com/barber/dashboard?tab=waitlist */
  dashboardUrl: string;
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
  if (!trimmed) return 'there';
  const space = trimmed.indexOf(' ');
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

export function waitlistBarberNotificationSubject(props: { customerName: string }): string {
  return `New waitlist request — ${props.customerName} asked for you`;
}

export function waitlistBarberNotificationHtml(props: WaitlistBarberNotificationProps): string {
  const barberFirst = escapeHtml(firstName(props.barberDisplayName));
  const customer = escapeHtml(props.customerName);
  const email = escapeHtml(props.customerEmail);
  const phone = escapeHtml(props.customerPhone);
  const phoneTel = escapeHtml(props.customerPhone.replace(/[^0-9+]/g, ''));
  const service = escapeHtml(props.serviceName);
  const windowLabel = props.windowLabel ? escapeHtml(props.windowLabel) : '';
  const prefLabel = props.preferenceLabel ? escapeHtml(props.preferenceLabel) : '';
  const note = props.note ? escapeHtml(props.note) : '';
  const dashboardUrl = escapeHtml(props.dashboardUrl);
  const shopPhone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>New waitlist request at Modern Classic</title>
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
                  New waitlist request
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  Hey ${barberFirst} — a customer just joined the waitlist and asked for you specifically.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;border:1px solid ${COLORS.border};border-radius:6px;background:${COLORS.bg};">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Customer</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};"><strong>${customer}</strong></p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Phone</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};"><a href="tel:${phoneTel}" style="color:${COLORS.gold};text-decoration:none;">${phone}</a></p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Email</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${email}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Service</p>
                      <p style="margin:0${windowLabel || prefLabel || note ? ' 0 14px' : ''};font-size:16px;color:${COLORS.ink};">${service}</p>
                      ${windowLabel ? `<p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Available window</p>
                      <p style="margin:0${prefLabel || note ? ' 0 14px' : ''};font-size:16px;color:${COLORS.ink};">${windowLabel}</p>` : ''}
                      ${prefLabel ? `<p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Preferences</p>
                      <p style="margin:0${note ? ' 0 14px' : ''};font-size:16px;color:${COLORS.ink};">${prefLabel}</p>` : ''}
                      ${note ? `<p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Note</p>
                      <p style="margin:0;font-size:16px;color:${COLORS.inkSoft};font-style:italic;">"${note}"</p>` : ''}
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 22px;text-align:center;">
                  <a href="${dashboardUrl}" style="display:inline-block;padding:12px 26px;background:${COLORS.gold};color:${COLORS.card};font-weight:700;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;border-radius:4px;">Open dashboard</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Tap the phone number above to text or call — they put themselves on the list, so they're expecting to hear from the shop. Shop line: ${shopPhone}.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 36px 26px;border-top:1px solid ${COLORS.border};text-align:center;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  You're getting this because a customer requested you by name on the Modern Classic waitlist. Update your notification email anytime at <span style="color:${COLORS.gold};">/barber/account</span>.
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

export function waitlistBarberNotificationText(props: WaitlistBarberNotificationProps): string {
  const barberFirst = firstName(props.barberDisplayName);
  const lines: string[] = [
    `Hey ${barberFirst} — a customer just joined the waitlist and asked for you specifically.`,
    '',
    `  Customer: ${props.customerName}`,
    `  Phone:    ${props.customerPhone}`,
    `  Email:    ${props.customerEmail}`,
    `  Service:  ${props.serviceName}`,
  ];
  if (props.windowLabel) lines.push(`  Window:   ${props.windowLabel}`);
  if (props.preferenceLabel) lines.push(`  Prefs:    ${props.preferenceLabel}`);
  if (props.note) {
    lines.push('', `  Note:     "${props.note}"`);
  }
  lines.push(
    '',
    `Open your dashboard: ${props.dashboardUrl}`,
    '',
    `Tap the phone number to text or call — they're expecting to hear from the shop.`,
    `Shop line: ${props.shopPhone}.`,
    '',
    "You're getting this because a customer requested you by name on the Modern Classic waitlist.",
    'Update your notification email anytime at /barber/account.',
  );
  return lines.join('\n');
}
