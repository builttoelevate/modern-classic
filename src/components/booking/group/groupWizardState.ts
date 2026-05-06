// Group booking wizard state machine. Mirrors the structure of the
// single-booking wizardState.ts but supports per-member service picks
// and the all-at-once / back-to-back fork.

import type { Barber, Service } from '../../../lib/square/types';
import type { GroupSlot } from '../../../lib/booking/groupAvailability';

export type GroupStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type GroupMode = 'all-at-once' | 'back-to-back';

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

export type GroupAction =
  | { type: 'GO_TO'; step: GroupStep }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'SET_SIZE'; size: 2 | 3 | 4 }
  | { type: 'SET_MEMBER_SERVICE'; key: string; service: Service }
  | { type: 'SET_MEMBER_NAME'; key: string; name: string }
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
      const allNamed = state.members.every((m) => m.displayName.trim().length > 0);
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
