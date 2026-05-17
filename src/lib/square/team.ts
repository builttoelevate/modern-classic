import { squareFetch } from './client';
import type { Barber, SearchTeamMembersResponse, TeamMember } from './types';

// SQUARE_REFERENCE.md §3 — Bill Chicha is the dev account, not displayed.
const HIDDEN_TEAM_MEMBER_IDS = new Set<string>(['TM3BJwsVNRbNXVZp']);

// Roles aren't stored in the Square API response in a way we can reliably
// pull, so we map them by ID to match what the shop publishes.
const ROLE_BY_ID: Record<string, string> = {
  '523GMGEC1FY0Z': 'Owner',
  TMZ4GRNFpRhnzLbv: 'Master Barber',
  TMwUNkXCCC_i3vyZ: 'Master Barber',
};

/** Sync-derived set of `team_member_id`s mapped to 'Owner' in ROLE_BY_ID.
 *  Single source of truth for "is this barber the shop owner?" — used by
 *  src/lib/auth/barberPermissions.ts AND src/lib/admin/auth.ts. The admin
 *  helper needs a sync check (Basic Auth is sync) so we can't lean on
 *  the async getBarbers() lookup for that case. */
export const OWNER_TEAM_MEMBER_IDS: ReadonlySet<string> = new Set(
  Object.entries(ROLE_BY_ID)
    .filter(([, role]) => role === 'Owner')
    .map(([id]) => id),
);

function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

function toBarber(member: TeamMember): Barber {
  const given = toTitleCase((member.given_name ?? '').trim());
  const family = toTitleCase((member.family_name ?? '').trim());
  const displayName = given || family || 'Barber';
  const email = (member.email_address ?? '').trim();
  return {
    id: member.id,
    givenName: given,
    familyName: family,
    displayName,
    role: ROLE_BY_ID[member.id] ?? 'Barber',
    ...(email ? { email } : {}),
  };
}

export async function getBarbers(): Promise<Barber[]> {
  const res = await squareFetch<SearchTeamMembersResponse>(
    '/v2/team-members/search',
    { method: 'POST', body: {} },
  );
  const members = (res.team_members ?? []).filter(
    (m) => m.status === 'ACTIVE' && !HIDDEN_TEAM_MEMBER_IDS.has(m.id),
  );
  return members.map(toBarber);
}
