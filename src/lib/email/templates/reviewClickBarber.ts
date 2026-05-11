// Barber-facing notification when a customer clicks through to leave
// a Google review for them. The click doesn't guarantee a review
// posts (Google doesn't notify back), but it's a strong signal — the
// customer wanted to write something good enough to follow the link.

export interface ReviewClickBarberProps {
  barberDisplayName: string;
  customerName: string;
  serviceName: string;
  /** Pre-formatted "Fri, Jun 26" or similar — the appointment date so
   *  the barber recognizes the visit. */
  appointmentDate: string;
  googleReviewUrl: string;
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

export function reviewClickBarberSubject(props: { customerName: string }): string {
  return `Nice — ${props.customerName} is leaving you a review`;
}

export function reviewClickBarberHtml(props: ReviewClickBarberProps): string {
  const first = escapeHtml(firstName(props.barberDisplayName));
  const customer = escapeHtml(props.customerName);
  const service = escapeHtml(props.serviceName);
  const appointmentDate = escapeHtml(props.appointmentDate);
  const reviewUrl = escapeHtml(props.googleReviewUrl);
  const shopPhone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>A customer is leaving you a review</title>
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
                  Customer review in progress
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  Nice work, ${first} — ${customer} just clicked through to leave you a Google review.
                </p>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:${COLORS.inkSoft};">
                  Reviews matter most when they mention the barber by name. If you spot one of yours land in the next day or two, drop a quick "thanks" reply — it makes a real difference.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;border:1px solid ${COLORS.border};border-radius:6px;background:${COLORS.bg};">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Customer</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${customer}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Service</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${service}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Appointment</p>
                      <p style="margin:0;font-size:16px;color:${COLORS.ink};">${appointmentDate}</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 22px;text-align:center;">
                  <a href="${reviewUrl}" style="display:inline-block;padding:12px 26px;background:${COLORS.gold};color:${COLORS.card};font-weight:700;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;border-radius:4px;">Open Google reviews</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Heads up: Google doesn't tell us when a review actually posts, so this is a "they clicked the link" notice, not a confirmation. Shop line: ${shopPhone}.
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

export function reviewClickBarberText(props: ReviewClickBarberProps): string {
  const first = firstName(props.barberDisplayName);
  return [
    `Nice work ${first} — ${props.customerName} just clicked through to leave you a Google review.`,
    '',
    'Reviews matter most when they mention the barber by name. If you spot one of yours land in the next day or two, drop a quick "thanks" reply — it makes a real difference.',
    '',
    `  Customer:    ${props.customerName}`,
    `  Service:     ${props.serviceName}`,
    `  Appointment: ${props.appointmentDate}`,
    '',
    `Open Google reviews: ${props.googleReviewUrl}`,
    '',
    `Heads up: Google doesn't tell us when a review actually posts, so this is a "they clicked the link" notice, not a confirmation. Shop line: ${props.shopPhone}.`,
  ].join('\n');
}
