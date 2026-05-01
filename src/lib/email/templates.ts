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
