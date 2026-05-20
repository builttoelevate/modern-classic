// Family-account "your invite was accepted" notification. Sent to
// the customer who originally sent the invite (from /api/family/invite)
// once the invitee taps Accept and successfully joins. Confirms the
// merge to the inviter so they know the other adult is on the
// account and a shared /my-bookings view is live.
//
// Parchment palette matches the rest of the customer-facing
// transactional mail (familyInvite, waitlistConfirmation,
// waitlistOpening, reviewRequest).

export interface FamilyInviteAcceptedProps {
  /** Name of the inviter — the recipient of THIS email. */
  inviterName: string;
  /** Display name of the person who accepted. Used in subject + body. */
  acceptedByName: string;
  /** Total adults in the family after the accept (>= 2). Drives the
   *  "you + N others" copy in the body. */
  totalMembers: number;
  /** Full URL to /my-bookings so the inviter can tap through and see
   *  the merged view. */
  myBookingsUrl: string;
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

export function familyInviteAcceptedSubject(
  props: Pick<FamilyInviteAcceptedProps, 'acceptedByName'>,
): string {
  return `${props.acceptedByName} joined your Modern Classic family account`;
}

export function familyInviteAcceptedHtml(props: FamilyInviteAcceptedProps): string {
  const inviter = escapeHtml(props.inviterName);
  const accepted = escapeHtml(props.acceptedByName);
  const myBookings = escapeHtml(props.myBookingsUrl);
  const address = escapeHtml(props.shopAddress);
  const memberCountCopy =
    props.totalMembers > 2
      ? `${props.totalMembers} members`
      : 'each other';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${accepted} joined your Modern Classic family account</title>
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
                  Family account update
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 8px;">
                <p style="margin:0 0 14px;font-size:18px;line-height:1.45;color:${COLORS.ink};">
                  Hi ${inviter} — <strong>${accepted}</strong> just joined your Modern Classic family account.
                </p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:${COLORS.inkSoft};">
                  From now on, your <strong>My bookings</strong> page shows ${memberCountCopy}'s appointments — and any kids' appointments — in one merged list. Same on their end.
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px;">
                  <tr>
                    <td align="center" style="background:${COLORS.gold};border-radius:4px;">
                      <a href="${myBookings}" style="display:inline-block;padding:14px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.textOnGold};text-decoration:none;">
                        Open my bookings
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:${COLORS.muted};">
                  Either of you can leave the family from your profile at any time. Leaving doesn't cancel any appointments — it just unmerges the views.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 36px 26px;border-top:1px solid ${COLORS.border};text-align:center;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  Modern Classic Barbershop &amp; Shave Parlor<br />
                  ${address}
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

export function familyInviteAcceptedText(props: FamilyInviteAcceptedProps): string {
  const memberCountCopy =
    props.totalMembers > 2
      ? `${props.totalMembers} members`
      : 'each other';
  return `Hi ${props.inviterName} — ${props.acceptedByName} just joined your Modern Classic family account.

From now on, your My bookings page shows ${memberCountCopy}'s appointments — and any kids' appointments — in one merged list. Same on their end.

Open My bookings:
${props.myBookingsUrl}

Either of you can leave the family from your profile at any time. Leaving doesn't cancel any appointments — it just unmerges the views.

—
Modern Classic Barbershop & Shave Parlor
${props.shopAddress}`;
}
