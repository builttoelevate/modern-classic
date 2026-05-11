// Family-account invite. Sent when an existing customer invites
// another adult (typically a spouse/partner) to share their
// Modern Classic family account. Parchment palette to match the
// waitlistConfirmation / waitlistOpening / reviewRequest emails so
// the visual language stays coherent across customer-facing mail.

export interface FamilyInviteProps {
  /** Name of the customer who's doing the inviting (e.g. "Bill"). */
  inviterName: string;
  /** /family/accept?token=… full URL. */
  acceptUrl: string;
  /** Pre-formatted "in 7 days" / "by Sat May 18" string for body copy. */
  expiresLabel: string;
  shopAddress: string;
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

export function familyInviteSubject(props: Pick<FamilyInviteProps, 'inviterName'>): string {
  return `${props.inviterName} invited you to share a Modern Classic family account`;
}

export function familyInviteHtml(props: FamilyInviteProps): string {
  const inviter = escapeHtml(props.inviterName);
  const acceptUrl = escapeHtml(props.acceptUrl);
  const expires = escapeHtml(props.expiresLabel);
  const address = escapeHtml(props.shopAddress);
  const phone = escapeHtml(props.shopPhone);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${inviter} invited you to share a Modern Classic family account</title>
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
                  Family account invite
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  <strong>${inviter}</strong> invited you to share their Modern Classic account.
                </p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:${COLORS.inkSoft};">
                  Accepting joins you to their family account. You'll each see the other's appointments — and any kids' appointments — in one merged list on <strong>My Bookings</strong>. No more juggling two phones to keep track of haircuts.
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px;">
                  <tr>
                    <td align="center" style="background:${COLORS.gold};border-radius:4px;">
                      <a href="${acceptUrl}" style="display:inline-block;padding:14px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.textOnGold};text-decoration:none;">
                        Accept invite
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 18px;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  This invite expires ${expires}. You can leave the family from your profile at any time.
                </p>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Or copy this link into your browser:
                </p>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.55;word-break:break-all;color:${COLORS.gold};">
                  <a href="${acceptUrl}" style="color:${COLORS.gold};text-decoration:underline;">${acceptUrl}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 36px 26px;border-top:1px solid ${COLORS.border};text-align:center;">
                <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  Didn't expect this? You can ignore it — nothing happens unless you tap Accept.
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

export function familyInviteText(props: FamilyInviteProps): string {
  return `${props.inviterName} invited you to share their Modern Classic account.

Accepting joins you to their family account. You'll each see the other's appointments — and any kids' appointments — in one merged list on My Bookings.

Accept here:
${props.acceptUrl}

This invite expires ${props.expiresLabel}. You can leave the family from your profile at any time.

Didn't expect this? You can ignore it — nothing happens unless you tap Accept.

—
Modern Classic Barbershop & Shave Parlor
${props.shopAddress}
${props.shopPhone}`;
}
