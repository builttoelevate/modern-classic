import type { Barber, Service, ServiceVariation, AvailabilitySlot } from '../../lib/square/types';

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export type WizardStatus =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; bookingId: string; emailDestination: string }
  | { kind: 'error'; message: string; slotTaken?: boolean; leadTimeTooShort?: boolean };

export interface CustomerInfo {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  note: string;
  /** When updating an existing customer record, whether to overwrite. */
  updateContact: boolean;
}

export interface WizardState {
  step: WizardStep;
  selectedService: Service | null;
  /** Resolved variation — for per-barber services this is set when a barber is picked. */
  selectedVariation: ServiceVariation | null;
  selectedBarber: Barber | null;
  /** True when the user picked "Any available barber" (no team filter on availability). */
  anyBarber: boolean;
  selectedSlot: AvailabilitySlot | null;
  /** Slot start_at strings the user has been told are unavailable — disable in step 3. */
  blockedSlots: string[];
  customer: CustomerInfo;
  status: WizardStatus;
}

export const initialCustomer: CustomerInfo = {
  givenName: '',
  familyName: '',
  email: '',
  phone: '',
  note: '',
  updateContact: false,
};

export const initialState: WizardState = {
  step: 1,
  selectedService: null,
  selectedVariation: null,
  selectedBarber: null,
  anyBarber: false,
  selectedSlot: null,
  blockedSlots: [],
  customer: initialCustomer,
  status: { kind: 'idle' },
};

export type WizardAction =
  | { type: 'SET_SERVICE'; service: Service }
  | { type: 'SET_BARBER'; barber: Barber; variation: ServiceVariation; anyBarber?: boolean }
  | { type: 'SET_ANY_BARBER'; variation: ServiceVariation }
  | { type: 'SET_SLOT'; slot: AvailabilitySlot }
  | { type: 'BLOCK_SLOT'; startAtUtc: string }
  | { type: 'UPDATE_CUSTOMER'; patch: Partial<CustomerInfo> }
  | { type: 'GO_TO'; step: WizardStep }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'STATUS'; status: WizardStatus }
  | { type: 'RESET' }
  | { type: 'HYDRATE'; state: WizardState };

export function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_SERVICE': {
      // Reset downstream when service changes.
      const sameService = state.selectedService?.id === action.service.id;
      return {
        ...state,
        selectedService: action.service,
        selectedVariation: sameService ? state.selectedVariation : null,
        selectedBarber: sameService ? state.selectedBarber : null,
        anyBarber: sameService ? state.anyBarber : false,
        selectedSlot: sameService ? state.selectedSlot : null,
        blockedSlots: sameService ? state.blockedSlots : [],
        step: 2,
      };
    }
    case 'SET_BARBER':
      return {
        ...state,
        selectedBarber: action.barber,
        selectedVariation: action.variation,
        anyBarber: action.anyBarber ?? false,
        selectedSlot: null,
        blockedSlots: [],
        step: 3,
      };
    case 'SET_ANY_BARBER':
      return {
        ...state,
        selectedBarber: null,
        selectedVariation: action.variation,
        anyBarber: true,
        selectedSlot: null,
        blockedSlots: [],
        step: 3,
      };
    case 'SET_SLOT':
      return { ...state, selectedSlot: action.slot, step: 4 };
    case 'BLOCK_SLOT':
      return {
        ...state,
        blockedSlots: state.blockedSlots.includes(action.startAtUtc)
          ? state.blockedSlots
          : [...state.blockedSlots, action.startAtUtc],
      };
    case 'UPDATE_CUSTOMER':
      return { ...state, customer: { ...state.customer, ...action.patch } };
    case 'GO_TO':
      return { ...state, step: action.step };
    case 'NEXT':
      if (state.step >= 5) return state;
      return { ...state, step: (state.step + 1) as WizardStep };
    case 'BACK':
      if (state.step <= 1) return state;
      return { ...state, step: (state.step - 1) as WizardStep };
    case 'STATUS':
      return { ...state, status: action.status };
    case 'RESET':
      return initialState;
    case 'HYDRATE':
      return action.state;
  }
}

export function isStepReachable(state: WizardState, step: WizardStep): boolean {
  if (step <= 1) return true;
  if (step === 2) return state.selectedService !== null;
  if (step === 3) return state.selectedService !== null && state.selectedVariation !== null;
  if (step === 4) return state.selectedSlot !== null;
  if (step === 5) return state.selectedSlot !== null && customerInfoValid(state.customer);
  return false;
}

export function customerInfoValid(c: CustomerInfo): boolean {
  if (!c.givenName.trim()) return false;
  if (!c.familyName.trim()) return false;
  if (!/^\S+@\S+\.\S+$/.test(c.email.trim())) return false;
  if (digits(c.phone).length !== 10) return false;
  if (c.note.length > 500) return false;
  return true;
}

export function digits(input: string): string {
  return input.replace(/\D/g, '');
}

export function formatPhone(input: string): string {
  const d = digits(input).slice(0, 10);
  if (d.length === 0) return '';
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function priceForService(service: Service | null, variation: ServiceVariation | null): string {
  if (!service) return '';
  if (variation && variation.priceCents !== null) return `$${(variation.priceCents / 100).toFixed(0)}`;
  if (service.minPriceCents !== null && service.maxPriceCents !== null) {
    if (service.minPriceCents === service.maxPriceCents) {
      return `$${(service.minPriceCents / 100).toFixed(0)}`;
    }
    return `$${(service.minPriceCents / 100).toFixed(0)}–$${(service.maxPriceCents / 100).toFixed(0)}`;
  }
  return 'Variable';
}
