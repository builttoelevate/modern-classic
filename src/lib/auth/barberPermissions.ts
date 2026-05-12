// Owner-role check for barber-facing features. Right now there's
// exactly one role tier above "regular barber" — the shop owner
// (Michael). Promoted barbers are flagged via the existing
// ROLE_BY_ID map at src/lib/square/team.ts.
//
// Using getBarbers() (which goes through that map) instead of
// hardcoding a team_member_id here keeps the source of truth in
// one place. If Michael ever steps back, editing ROLE_BY_ID is the
// one change needed.

import { getBarbers } from '../square/team';

export async function isBarberOwner(barberId: string): Promise<boolean> {
  const id = (barberId ?? '').trim();
  if (!id) return false;
  try {
    const all = await getBarbers();
    return all.some((b) => b.id === id && b.role === 'Owner');
  } catch {
    // Square outage shouldn't grant elevation. Fail closed.
    return false;
  }
}
