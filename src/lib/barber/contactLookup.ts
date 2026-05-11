// Single source of truth for resolving "where do barber notifications
// go?" — used by every event that emails a specific barber (waitlist
// submit, waitlist slot match, no-show charge, password reset, review
// click). Account email wins; Square's TeamMember.email_address is the
// fallback; if neither is set, returns null and the caller skips
// silently.
//
// The display-name lookup follows the same precedence as the
// /barber/dashboard render: Square's roster is the source of truth so
// the barber sees their real name in their inbox, not the username
// they happen to type at the sign-in form.

import { getAccount } from './accountStore';
import { getBarbers } from '../square/team';

export interface BarberContact {
  /** Inbox to send to. Always lower-cased + trimmed. */
  email: string;
  /** Display name for the email greeting ("Hey Rick — ..."). */
  displayName: string;
}

/** Resolve a single barber's notification contact info. Returns null
 *  when neither the account record nor the Square TeamMember has an
 *  email — that's a valid "skip this barber silently" signal, not an
 *  error worth bubbling up. */
export async function resolveBarberContact(
  teamMemberId: string,
): Promise<BarberContact | null> {
  if (!teamMemberId) return null;
  const [account, roster] = await Promise.all([
    getAccount(teamMemberId).catch(() => null),
    getBarbers().catch(() => []),
  ]);
  const squareEntry = roster.find((b) => b.id === teamMemberId);
  const email = (account?.email && account.email.trim())
    || (squareEntry?.email && squareEntry.email.trim())
    || '';
  if (!email) return null;
  return {
    email: email.toLowerCase(),
    displayName: squareEntry?.displayName || account?.username || 'there',
  };
}

/** Batch variant. Resolves N team_member_ids in parallel using a
 *  single getBarbers() call so we don't hammer the Square API. Returns
 *  a map keyed by team_member_id; missing keys = no resolvable inbox. */
export async function resolveBarberContacts(
  teamMemberIds: string[],
): Promise<Map<string, BarberContact>> {
  const ids = Array.from(new Set(teamMemberIds.filter((id) => !!id)));
  if (ids.length === 0) return new Map();
  const [accounts, roster] = await Promise.all([
    Promise.all(ids.map((id) => getAccount(id).catch(() => null))),
    getBarbers().catch(() => []),
  ]);
  const rosterById = new Map(roster.map((b) => [b.id, b] as const));
  const out = new Map<string, BarberContact>();
  ids.forEach((id, i) => {
    const account = accounts[i];
    const squareEntry = rosterById.get(id);
    const email = (account?.email && account.email.trim())
      || (squareEntry?.email && squareEntry.email.trim())
      || '';
    if (!email) return;
    out.set(id, {
      email: email.toLowerCase(),
      displayName: squareEntry?.displayName || account?.username || 'there',
    });
  });
  return out;
}
