// Group booking wizard state machine. Mirrors the structure of the
// single-booking wizardState.ts but supports per-member service picks
// and the all-at-once / back-to-back fork.

import type { Barber, Service } from '../../../lib/square/types';
import type { GroupSlot } from '../../../lib/booking/groupAvailability';

export type GroupStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type GroupMode = 'all-at-once' | 'back-to-back';

/** Preset that re-creates a previously-booked group so the customer can
 *  "Book the whole group again" from /my-bookings in one tap. We carry
 *  the original variation ids + barber + mode through the URL so the
 *  wizard skips ahead to the Time step (or Barber step if the original
 *  back-to-back barber is no longer eligible). */
export interface GroupBookingPreset {
  mode: GroupMode;
  /** Only meaningful when mode === 'back-to-back' — the single barber
   *  the original group used. May resolve to null if that barber has
   *  left the roster; the wizard falls back to Step 4 in that case. */
  teamMemberId?: string;
  members: Array<{
    serviceVariationId: string;
    /** Display name for non-self members. Empty string for self. */
    displayName: string;
    /** True if this member is the parent themselves on the original
     *  group booking. */
    isSelf?: boolean;
  }>;
}

export interface MemberDraft {
  /** Stable UI id for the React list. */
  key: string;
  /** Per-person display name — optional during the picker steps,
   * collected on Step 6. */
  displayName: string;
  /** Picked service. Null until Step 2. The matcher resolves which
   * specific variation to use per (member, barber) pair — needed
   * because Square stores per-barber-priced services as N variations
   * (one per barber), so eligibleBarberIds varies by variation. */
  service: Service | null;
  /** Routing for this member's booking on submit:
   *   'new'      — type a fresh name; the backend creates a Square
   *                customer record + links them under the parent
   *                profile so future group bookings can pick them
   *                straight from the dropdown.
   *   'self'     — this member is the parent themselves.
   *   'existing' — this member is one of the parent's already-linked
   *                people; uses `existingCustomerId`.
   * Defaults to 'new'. Step 6 lets the parent flip between these. */
  who: 'self' | 'existing' | 'new';
  /** Set when who === 'existing'. Square customer_id of the linked
   * person the parent picked. */
  existingCustomerId?: string;
}

export interface ParentDraft {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
}

export type GroupStatus =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | {
      kind: 'success';
      groupId: string;
      bookings: Array<{ memberKey: string; bookingId: string | null }>;
      failures: Array<{
        memberKey: string;
        displayName: string;
        code: string;
        detail: string;
        slotTaken: boolean;
      }>;
    }
  | { kind: 'error'; message: string };

export interface GroupWizardState {
  step: GroupStep;
  size: 2 | 3 | 4;
  members: MemberDraft[];
  mode: GroupMode | null;
  /** Required only when mode === 'back-to-back'. */
  selectedBarber: Barber | null;
  /** Loaded after Step 4 — null while we wait for the API. */
  availableSlots: GroupSlot[] | null;
  /** Picked group slot (resolved with per-member assignments). */
  selectedSlot: GroupSlot | null;
  parent: ParentDraft;
  groupNote: string;
  status: GroupStatus;
}

const memberKey = (i: number): string => `m${i + 1}`;

export function makeInitialState(initialSize: 2 | 3 | 4 = 2): GroupWizardState {
  return {
    step: 1,
    size: initialSize,
    members: Array.from({ length: initialSize }, (_, i) => ({
      key: memberKey(i),
      displayName: '',
      service: null,
      who: 'new' as const,
    })),
    mode: null,
    selectedBarber: null,
    availableSlots: null,
    selectedSlot: null,
    parent: { givenName: '', familyName: '', email: '', phone: '' },
    groupNote: '',
    status: { kind: 'idle' },
  };
}

/** Find the parent Service that owns a given variation id. Per-barber
 *  pricing stores N variations under one service, so we walk every
 *  service until we find the one containing this variation. */
function findServiceForVariation(
  services: Service[],
  variationId: string,
): Service | null {
  for (const s of services) {
    if (s.variations.some((v) => v.id === variationId)) return s;
  }
  return null;
}

export interface PresetResolverInput {
  preset: GroupBookingPreset;
  services: Service[];
  barbers: Barber[];
  /** Optional saved-people list so we can pre-link a preset's display
   *  name back to a 'self' or 'existing' chip instead of treating it
   *  as a fresh 'new' name. */
  savedPeople?: Array<{ customerId: string; displayName: string; isSelf: boolean }>;
}

/** Build a wizard state that re-creates a previously-booked group from
 *  the supplied preset. Resolves variation ids to parent services and
 *  the (optional) back-to-back barber id to a Barber. Jumps the wizard
 *  past every step whose pick was already determined by the preset:
 *  Step 5 (Time) when everything resolves, Step 4 (Barber) when the
 *  original back-to-back barber is gone, Step 1 if catalog drift makes
 *  the preset unusable. */
export function makeStateFromPreset({
  preset,
  services,
  barbers,
  savedPeople = [],
}: PresetResolverInput): GroupWizardState {
  const size = (Math.max(2, Math.min(4, preset.members.length)) as 2 | 3 | 4);
  const members: MemberDraft[] = preset.members.slice(0, size).map((m, i) => {
    const service = findServiceForVariation(services, m.serviceVariationId);
    // Match the supplied displayName back to a saved-person chip when
    // we can. Self matches by isSelf; everyone else matches by name
    // (case-insensitive, trimmed) so "briar bone" rehydrates onto the
    // "Briar Bone" chip the wizard would otherwise render.
    let who: MemberDraft['who'] = 'new';
    let existingCustomerId: string | undefined;
    let displayName = m.displayName ?? '';
    if (m.isSelf) {
      const selfOption = savedPeople.find((p) => p.isSelf);
      if (selfOption) {
        who = 'self';
        displayName = selfOption.displayName;
      }
    } else if (displayName.trim()) {
      const match = savedPeople.find(
        (p) =>
          !p.isSelf &&
          p.displayName.trim().toLowerCase() === displayName.trim().toLowerCase(),
      );
      if (match) {
        who = 'existing';
        existingCustomerId = match.customerId;
      }
    }
    return {
      key: memberKey(i),
      displayName,
      service,
      who,
      existingCustomerId,
    };
  });

  const allServicesResolved = members.every((m) => m.service !== null);

  let selectedBarber: Barber | null = null;
  if (preset.mode === 'back-to-back' && preset.teamMemberId) {
    selectedBarber = barbers.find((b) => b.id === preset.teamMemberId) ?? null;
    if (selectedBarber) {
      // Verify the barber can still cover every preset service. If a
      // variation has been retired or the barber's eligibility list
      // shrank, drop the preselection and let the customer pick fresh
      // on Step 4.
      const covers = members.every((m) => {
        if (!m.service) return false;
        return m.service.variations.some(
          (v) =>
            v.availableForBooking &&
            v.eligibleTeamMemberIds.includes(selectedBarber!.id),
        );
      });
      if (!covers) selectedBarber = null;
    }
  }

  // Decide which step to land on:
  //   - All preset data resolved → jump straight to Step 5 (Time).
  //   - Back-to-back but the original barber is gone → Step 4 so the
  //     customer can pick a replacement.
  //   - Catalog drift dropped a service → Step 2 so the customer can
  //     reselect missing services.
  //   - Anything else unexpected → Step 1 for a clean restart.
  let step: GroupStep;
  if (!allServicesResolved) {
    step = 2;
  } else if (preset.mode === 'back-to-back' && !selectedBarber) {
    step = 4;
  } else {
    step = 5;
  }

  return {
    step,
    size,
    members,
    mode: preset.mode,
    selectedBarber,
    availableSlots: null,
    selectedSlot: null,
    parent: { givenName: '', familyName: '', email: '', phone: '' },
    groupNote: '',
    status: { kind: 'idle' },
  };
}

export type GroupAction =
  | { type: 'GO_TO'; step: GroupStep }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'SET_SIZE'; size: 2 | 3 | 4 }
  | { type: 'SET_MEMBER_SERVICE'; key: string; service: Service }
  | { type: 'SET_MEMBER_NAME'; key: string; name: string }
  | {
      type: 'SET_MEMBER_WHO';
      key: string;
      who: 'self' | 'existing' | 'new';
      existingCustomerId?: string;
      displayName?: string;
    }
  | { type: 'SET_MODE'; mode: GroupMode }
  | { type: 'SET_BARBER'; barber: Barber | null }
  | { type: 'SET_AVAILABLE_SLOTS'; slots: GroupSlot[] | null }
  | { type: 'SET_SLOT'; slot: GroupSlot | null }
  | { type: 'SET_PARENT'; patch: Partial<ParentDraft> }
  | { type: 'SET_GROUP_NOTE'; note: string }
  | { type: 'SET_STATUS'; status: GroupStatus }
  | { type: 'RESET' };

export function reducer(state: GroupWizardState, action: GroupAction): GroupWizardState {
  switch (action.type) {
    case 'GO_TO':
      return { ...state, step: action.step };
    case 'NEXT':
      return { ...state, step: clamp(state.step + 1) };
    case 'BACK':
      return { ...state, step: clamp(state.step - 1) };

    case 'SET_SIZE': {
      const size = action.size;
      const members: MemberDraft[] = [];
      for (let i = 0; i < size; i++) {
        members.push(
          state.members[i] ?? {
            key: memberKey(i),
            displayName: '',
            service: null,
            who: 'new',
          },
        );
      }
      return {
        ...state,
        size,
        members,
        // Truncating size invalidates downstream choices.
        mode: null,
        selectedBarber: null,
        availableSlots: null,
        selectedSlot: null,
      };
    }

    case 'SET_MEMBER_SERVICE': {
      return {
        ...state,
        members: state.members.map((m) =>
          m.key === action.key ? { ...m, service: action.service } : m,
        ),
        // A service swap invalidates downstream availability.
        availableSlots: null,
        selectedSlot: null,
      };
    }

    case 'SET_MEMBER_NAME': {
      return {
        ...state,
        members: state.members.map((m) =>
          m.key === action.key ? { ...m, displayName: action.name } : m,
        ),
      };
    }

    case 'SET_MEMBER_WHO': {
      return {
        ...state,
        members: state.members.map((m) => {
          if (m.key !== action.key) return m;
          return {
            ...m,
            who: action.who,
            existingCustomerId:
              action.who === 'existing' ? action.existingCustomerId : undefined,
            displayName: action.displayName ?? m.displayName,
          };
        }),
      };
    }

    case 'SET_MODE': {
      return {
        ...state,
        mode: action.mode,
        selectedBarber: action.mode === 'all-at-once' ? null : state.selectedBarber,
        availableSlots: null,
        selectedSlot: null,
      };
    }

    case 'SET_BARBER': {
      return {
        ...state,
        selectedBarber: action.barber,
        availableSlots: null,
        selectedSlot: null,
      };
    }

    case 'SET_AVAILABLE_SLOTS':
      return { ...state, availableSlots: action.slots };

    case 'SET_SLOT':
      return { ...state, selectedSlot: action.slot };

    case 'SET_PARENT':
      return { ...state, parent: { ...state.parent, ...action.patch } };

    case 'SET_GROUP_NOTE':
      return { ...state, groupNote: action.note };

    case 'SET_STATUS':
      return { ...state, status: action.status };

    case 'RESET':
      return makeInitialState(state.size);

    default:
      return state;
  }
}

function clamp(s: number): GroupStep {
  if (s < 1) return 1;
  if (s > 7) return 7;
  return s as GroupStep;
}

/** True when the wizard's user can advance from `step` to `step + 1`. */
export function canAdvance(state: GroupWizardState): boolean {
  switch (state.step) {
    case 1:
      return true; // size is always set
    case 2:
      return state.members.every((m) => m.service !== null);
    case 3:
      return state.mode !== null;
    case 4:
      return state.mode === 'all-at-once' || state.selectedBarber !== null;
    case 5:
      return state.selectedSlot !== null;
    case 6: {
      const p = state.parent;
      // 'self' and 'existing' rows already have a name pinned to a
      // real Square customer record; only 'new' rows need a typed
      // displayName before we can advance.
      const allNamed = state.members.every((m) => {
        if (m.who === 'self' || m.who === 'existing') return true;
        return m.displayName.trim().length > 0;
      });
      return (
        p.givenName.trim().length > 0 &&
        p.familyName.trim().length > 0 &&
        /^\S+@\S+\.\S+$/.test(p.email.trim()) &&
        p.phone.replace(/\D/g, '').length >= 10 &&
        allNamed
      );
    }
    case 7:
      return state.status.kind !== 'submitting';
    default:
      return false;
  }
}
