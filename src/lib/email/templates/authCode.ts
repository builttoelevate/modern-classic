// Sign-in code email — same parchment palette as the magic-link
// template so the customer's "Modern Classic" inbox stays visually
// consistent. The 6-digit code is the body; no clickable link.
//
// Why no link: this template exists specifically because magic links
// fail on iOS for users whose email client opens links in an
// isolated in-app browser (ProtonMail, sometimes Outlook). The
// customer reads the code in whatever email app they prefer, swipes
// back to the sign-in form (still open in their browser / home-
// screen web app), and types it in — the auth cookie lands in the
// correct cookie jar without any link-tap handoff.

export interface AuthCodeProps {
  /** The 6-digit numeric code, e.g. "428193". */
  code: string;
  /** Customer's first name, if known. Used in the greeting. */
  customerName?: string;
  /** Minutes the code is valid for, for display in the body. */
  ttlMinutes: number;
  /** Shop phone for the footer "didn't request this?" callout. */
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
  codeBg: '#1c1814',
  codeInk: '#f5efe4',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(full: string | undefined): string {
  const trimmed = (full ?? '').trim();
  if (!trimmed) return 'friend';
  const space = trimmed.indexOf(' ');
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

export function authCodeSubject(code: string): string {
  // Putting the code in the subject line is a Gmail-on-iOS / Apple
  // Mail preview convenience — the customer can read it from the
  // notification or the inbox preview without opening the email,
  // then swipe back to the sign-in form. Safe because the email is
  // single-use, expires fast, and only goes to the address the
  // customer just typed into the form themselves.
  return `${code} is your Modern Classic sign-in code`;
}

export function authCodeHtml(props: AuthCodeProps): string {
  const first = escapeHtml(firstName(props.customerName));
  const code = escapeHtml(props.code);
  const ttl = String(Math.max(1, Math.floor(props.ttlMinutes)));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your Modern Classic sign-in code</title>
  </head>
  <body style="margin:0;padding:0;background:${COLORS.bg};color:${COLORS.ink};font-family:'Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.bg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellspacing="0" cellpadding="0" border="0" style="max-width:480px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 12px;text-align:center;border-bottom:1px solid ${COLORS.border};">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:0.02em;color:${COLORS.ink};">
                  Modern <span style="color:${COLORS.gold};">·</span> Classic
                </div>
                <div style="margin-top:6px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.muted};">
                  Sign-in code
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 8px;">
                <p style="margin:0 0 14px;font-size:17px;line-height:1.45;color:${COLORS.ink};">Hi ${first} —</p>
                <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:${COLORS.inkSoft};">
                  Type this code on the Modern Classic sign-in page. It works for the next ${ttl} minutes.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;">
                  <tr>
                    <td align="center" style="padding:18px;background:${COLORS.codeBg};border-radius:6px;">
                      <div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:34px;letter-spacing:0.32em;color:${COLORS.codeInk};font-weight:600;padding-left:0.32em;">${code}</div>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Didn't ask for this? Ignore the email — the code expires on its own. Worried? Reply to this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 32px 24px;border-top:1px solid ${COLORS.border};font-size:11px;letter-spacing:0.06em;color:${COLORS.muted};text-align:center;">
                Modern Classic Barbershop · 819 Linden Ave, Zanesville, OH
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function authCodeText(props: AuthCodeProps): string {
  const first = firstName(props.customerName);
  const ttl = Math.max(1, Math.floor(props.ttlMinutes));
  return [
    `Hi ${first} —`,
    '',
    `Your Modern Classic sign-in code: ${props.code}`,
    '',
    `Type this on the sign-in page. It works for the next ${ttl} minutes.`,
    '',
    `Didn't ask for this? Ignore the email — the code expires on its own.`,
    `Worried? Reply to this email.`,
    '',
    'Modern Classic Barbershop',
    '819 Linden Ave, Zanesville, OH',
  ].join('\n');
}
