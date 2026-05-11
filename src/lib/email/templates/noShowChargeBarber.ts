// Barber-facing notification when the shop marks a no-show and
// successfully charges the customer's card on file. Sends the
// assigned barber a concise summary so they can update their notes
// and know the slot is permanently lost (and was paid).

export interface NoShowChargeBarberProps {
  barberDisplayName: string;
  customerName: string;
  serviceName: string;
  /** Pre-formatted "Fri, Jun 26 at 11:00 AM" style string. */
  whenLabel: string;
  /** Charge amount in cents — we format as $XX.XX in the template. */
  amountCents: number;
  shopPhone: string;
}

const COLORS = {
  bg: '#f5efe4',
  card: '#ffffff',
  border: '#e6dccc',
  ink: '#1c1814',
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

function formatAmount(cents: number): string {
  if (!Number.isFinite(cents)) return '$—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function noShowChargeBarberSubject(props: { customerName: string }): string {
  return `No-show charged — ${props.customerName}`;
}

export function noShowChargeBarberHtml(props: NoShowChargeBarberProps): string {
  const first = escapeHtml(firstName(props.barberDisplayName));
  const customer = escapeHtml(props.customerName);
  const service = escapeHtml(props.serviceName);
  const whenLabel = escapeHtml(props.whenLabel);
  const amount = escapeHtml(formatAmount(props.amountCents));
  const shopPhone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>No-show charged</title>
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
                  No-show charged
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  Hi ${first} — heads up, ${customer} no-showed your appointment and the shop charged their card on file.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;border:1px solid ${COLORS.border};border-radius:6px;background:${COLORS.bg};">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Customer</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${customer}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Service</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${service}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Was scheduled for</p>
                      <p style="margin:0 0 14px;font-size:16px;color:${COLORS.ink};">${whenLabel}</p>
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Amount charged</p>
                      <p style="margin:0;font-size:16px;color:${COLORS.ink};"><strong>${amount}</strong></p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Questions about the charge or want it reversed? Call the shop at ${shopPhone}.
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

export function noShowChargeBarberText(props: NoShowChargeBarberProps): string {
  const first = firstName(props.barberDisplayName);
  return [
    `Hi ${first} — heads up, ${props.customerName} no-showed your appointment and the shop charged their card on file.`,
    '',
    `  Customer:        ${props.customerName}`,
    `  Service:         ${props.serviceName}`,
    `  Was scheduled:   ${props.whenLabel}`,
    `  Amount charged:  ${formatAmount(props.amountCents)}`,
    '',
    `Questions about the charge or want it reversed? Call the shop at ${props.shopPhone}.`,
  ].join('\n');
}
