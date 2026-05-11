// Barber-facing alert when the hourly waitlist-notify cron finds a
// slot that matches a customer's preferences AND the customer asked
// for this barber specifically. Sister template to waitlistOpening
// (which goes to the customer) — both fire from the same cron pass,
// so the barber is prepped if the customer calls minutes after their
// email lands.

export interface WaitlistSlotMatchBarberProps {
  barberDisplayName: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  /** Pre-formatted "Fri, Jun 26 at 11:00 AM" style string. */
  whenLabel: string;
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

export function waitlistSlotMatchBarberSubject(props: { customerName: string; whenLabel: string }): string {
  return `Heads up — ${props.customerName}'s waitlist slot just opened (${props.whenLabel})`;
}

export function waitlistSlotMatchBarberHtml(props: WaitlistSlotMatchBarberProps): string {
  const barberFirst = escapeHtml(firstName(props.barberDisplayName));
  const customer = escapeHtml(props.customerName);
  const email = escapeHtml(props.customerEmail);
  const phone = escapeHtml(props.customerPhone);
  const phoneTel = escapeHtml(props.customerPhone.replace(/[^0-9+]/g, ''));
  const service = escapeHtml(props.serviceName);
  const whenLabel = escapeHtml(props.whenLabel);
  const dashboardUrl = escapeHtml(props.dashboardUrl);
  const shopPhone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Waitlist slot opening at Modern Classic</title>
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
                  Waitlist slot opened
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  Heads up, ${barberFirst} — ${customer} is on your waitlist and a matching slot just opened. We've already emailed them; expect a quick call back.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;border:1px solid ${COLORS.border};border-radius:6px;background:${COLORS.bg};">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">When</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};"><strong>${whenLabel}</strong></p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Customer</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${customer}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Phone</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};"><a href="tel:${phoneTel}" style="color:${COLORS.gold};text-decoration:none;">${phone}</a></p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Email</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${email}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Service</p>
                      <p style="margin:0;font-size:16px;color:${COLORS.ink};">${service}</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 22px;text-align:center;">
                  <a href="${dashboardUrl}" style="display:inline-block;padding:12px 26px;background:${COLORS.gold};color:${COLORS.card};font-weight:700;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;border-radius:4px;">Open dashboard</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  These are first-come, first-served — if you don't hear from them shortly the slot will likely go to another customer. Shop line: ${shopPhone}.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 36px 26px;border-top:1px solid ${COLORS.border};text-align:center;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  You're getting this because ${customer} put themselves on the waitlist and asked for you by name. Update your notification email anytime at <span style="color:${COLORS.gold};">/barber/account</span>.
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

export function waitlistSlotMatchBarberText(props: WaitlistSlotMatchBarberProps): string {
  const barberFirst = firstName(props.barberDisplayName);
  return [
    `Heads up ${barberFirst} — ${props.customerName} is on your waitlist and a matching slot just opened. We've already emailed them; expect a quick call back.`,
    '',
    `  When:     ${props.whenLabel}`,
    `  Customer: ${props.customerName}`,
    `  Phone:    ${props.customerPhone}`,
    `  Email:    ${props.customerEmail}`,
    `  Service:  ${props.serviceName}`,
    '',
    `Open your dashboard: ${props.dashboardUrl}`,
    '',
    `Shop line: ${props.shopPhone}.`,
    '',
    `You're getting this because ${props.customerName} put themselves on the waitlist and asked for you by name. Update your notification email anytime at /barber/account.`,
  ].join('\n');
}
