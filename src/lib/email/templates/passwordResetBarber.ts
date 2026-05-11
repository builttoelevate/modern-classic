// Security notification when an admin resets the barber's password.
// We DO NOT include the new plaintext password — Michael will hand
// that over out-of-band. This email's job is "you should know your
// account was reset, and here's what to expect."

export interface PasswordResetBarberProps {
  barberDisplayName: string;
  username: string;
  signInUrl: string;
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

export function passwordResetBarberSubject(): string {
  return 'Your Modern Classic dashboard password was reset';
}

export function passwordResetBarberHtml(props: PasswordResetBarberProps): string {
  const first = escapeHtml(firstName(props.barberDisplayName));
  const username = escapeHtml(props.username);
  const signInUrl = escapeHtml(props.signInUrl);
  const shopPhone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Password reset</title>
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
                  Account security
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  Hi ${first} — your dashboard password was just reset by the shop owner.
                </p>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:${COLORS.ink};">
                  Michael will send you the new temporary password by text. Once you sign in with it, the dashboard will ask you to set a fresh password of your own.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;border:1px solid ${COLORS.border};border-radius:6px;background:${COLORS.bg};">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.gold};font-weight:700;">Your username</p>
                      <p style="margin:0;font-size:16px;color:${COLORS.ink};font-family:ui-monospace,monospace;">${username}</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 22px;text-align:center;">
                  <a href="${signInUrl}" style="display:inline-block;padding:12px 26px;background:${COLORS.gold};color:${COLORS.card};font-weight:700;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;border-radius:4px;">Sign in</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  <strong>Didn't expect this?</strong> Call the shop at ${shopPhone} — your account may have been reset in error and you should let Michael know.
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

export function passwordResetBarberText(props: PasswordResetBarberProps): string {
  const first = firstName(props.barberDisplayName);
  return [
    `Hi ${first} — your dashboard password was just reset by the shop owner.`,
    '',
    'Michael will send you the new temporary password by text. Once you sign in with it, the dashboard will ask you to set a fresh password of your own.',
    '',
    `  Username: ${props.username}`,
    '',
    `Sign in: ${props.signInUrl}`,
    '',
    `Didn't expect this? Call the shop at ${props.shopPhone} — your account may have been reset in error and you should let Michael know.`,
  ].join('\n');
}
