// Phase 5 Part A — magic-link email templates.
//
// Plain string concatenation is fine here. Inline CSS only — most clients
// strip <style> blocks and don't honor external sheets. Keep the palette
// in lockstep with src/styles/tokens.css so the email reads as part of
// the brand.

interface MagicLinkProps {
  magicUrl: string;
  customerName?: string;
}

const COLORS = {
  bg: '#0b0a08',
  card: '#161311',
  border: '#2a2520',
  gold: '#c9a35c',
  goldLight: '#e6c785',
  text: '#f3ece0',
  textMuted: '#b0a695',
  textOnGold: '#161311',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function magicLinkHtml({ magicUrl, customerName }: MagicLinkProps): string {
  const greeting = customerName?.trim() ? `Hi ${escapeHtml(customerName.trim())},` : 'Hi there,';
  const safeUrl = escapeHtml(magicUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in to Modern Classic</title>
  </head>
  <body style="margin:0;padding:0;background:${COLORS.bg};color:${COLORS.text};font-family:'Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.bg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:32px 36px 16px;text-align:center;border-bottom:1px solid ${COLORS.border};">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:0.02em;color:${COLORS.text};">
                  Modern <span style="color:${COLORS.gold};">·</span> Classic
                </div>
                <div style="margin-top:6px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.textMuted};">
                  Barbershop &amp; Shave Parlor
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${COLORS.text};">${greeting}</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${COLORS.text};">
                  Tap the button below to sign in to your Modern Classic account and view your bookings.
                </p>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:${COLORS.textMuted};">
                  This link expires in 15 minutes and can only be used once.
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
                  <tr>
                    <td align="center" style="background:${COLORS.gold};border-radius:4px;">
                      <a href="${safeUrl}" style="display:inline-block;padding:14px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.textOnGold};text-decoration:none;">
                        Sign in to Modern Classic
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:${COLORS.textMuted};">
                  Or copy and paste this URL into your browser:
                </p>
                <p style="margin:0 0 24px;font-size:13px;line-height:1.55;word-break:break-all;color:${COLORS.goldLight};">
                  <a href="${safeUrl}" style="color:${COLORS.goldLight};text-decoration:underline;">${safeUrl}</a>
                </p>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:${COLORS.textMuted};">
                  If you didn't request this, you can safely ignore this email — no one can sign in without the link.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 36px 28px;border-top:1px solid ${COLORS.border};text-align:center;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.textMuted};">
                  Modern Classic Barbershop &amp; Shave Parlor<br />
                  819 Linden Avenue · Zanesville, OH 43701 · 740-297-4462
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

export function magicLinkText({ magicUrl, customerName }: MagicLinkProps): string {
  const greeting = customerName?.trim() ? `Hi ${customerName.trim()},` : 'Hi there,';
  return `${greeting}

Tap the link below to sign in to your Modern Classic account and view your bookings. This link expires in 15 minutes and can only be used once.

${magicUrl}

If you didn't request this, you can safely ignore this email — no one can sign in without the link.

—
Modern Classic Barbershop & Shave Parlor
819 Linden Avenue · Zanesville, OH 43701
740-297-4462`;
}

export interface WaitlistRequestProps {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  barberName: string;
  preferredDate?: string;
  note?: string;
  submittedAt: string;
}

export function waitlistRequestHtml(p: WaitlistRequestProps): string {
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid ${COLORS.border};color:${COLORS.textMuted};font-size:12px;letter-spacing:0.16em;text-transform:uppercase;width:140px;">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid ${COLORS.border};color:${COLORS.text};font-size:15px;">${escapeHtml(value)}</td>
    </tr>`;
  const optionalNote = p.note?.trim()
    ? `<tr><td colspan="2" style="padding:14px 12px;color:${COLORS.text};font-size:14px;line-height:1.55;background:${COLORS.bg};">${escapeHtml(p.note.trim())}</td></tr>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Waitlist request — Modern Classic</title></head>
  <body style="margin:0;padding:0;background:${COLORS.bg};color:${COLORS.text};font-family:'Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.bg};padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;">
          <tr><td style="padding:24px 28px 12px;border-bottom:1px solid ${COLORS.border};">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:${COLORS.text};">New waitlist request</div>
            <div style="margin-top:4px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.gold};">Modern Classic</div>
          </td></tr>
          <tr><td style="padding:18px 28px 4px;color:${COLORS.text};font-size:15px;line-height:1.55;">
            <p style="margin:0 0 14px;">${escapeHtml(p.customerName)} couldn't find a time on the booking calendar and asked to be added to the waitlist. Reach out when an opening appears.</p>
          </td></tr>
          <tr><td style="padding:0 28px 18px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${COLORS.border};border-radius:6px;overflow:hidden;">
              ${row('Customer', p.customerName)}
              ${row('Email', p.customerEmail)}
              ${row('Phone', p.customerPhone)}
              ${row('Service', p.serviceName)}
              ${row('Barber', p.barberName)}
              ${p.preferredDate ? row('Preferred date', p.preferredDate) : ''}
              ${row('Submitted', p.submittedAt)}
              ${optionalNote}
            </table>
          </td></tr>
          <tr><td style="padding:18px 28px 24px;border-top:1px solid ${COLORS.border};text-align:center;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.textMuted};">
              Reply directly to this email to reach ${escapeHtml(p.customerName)}.<br />
              Modern Classic Barbershop &amp; Shave Parlor · 740-297-4462
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function waitlistRequestText(p: WaitlistRequestProps): string {
  const lines = [
    `New waitlist request — Modern Classic`,
    ``,
    `${p.customerName} couldn't find a time on the booking calendar and asked to be added to the waitlist.`,
    ``,
    `Customer: ${p.customerName}`,
    `Email:    ${p.customerEmail}`,
    `Phone:    ${p.customerPhone}`,
    `Service:  ${p.serviceName}`,
    `Barber:   ${p.barberName}`,
  ];
  if (p.preferredDate) lines.push(`Preferred date: ${p.preferredDate}`);
  lines.push(`Submitted: ${p.submittedAt}`);
  if (p.note?.trim()) {
    lines.push('', `Note: ${p.note.trim()}`);
  }
  lines.push('', `Reply to this email to reach ${p.customerName} directly.`);
  return lines.join('\n');
}
