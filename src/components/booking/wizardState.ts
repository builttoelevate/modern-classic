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
  /**
   * Phase 7 — true when the customer ticked the marketing-consent
   * checkbox on Step 4. Default false. Pre-checked defaults are forbidden
   * under GDPR/CAN-SPAM best practice.
   */
  marketingConsent: boolean;
}

/** Card-capture step (Step 4.5) — only relevant for new customers. */
export interface CardCaptureState {
  /** null = not yet evaluated, true = wizard must show Step 4.5,
   *  false = customer is returning, skip the step entirely. */
  required: boolean | null;
  /** Square customer_id resolved by /api/booking/check-new-customer.
   *  Used both for /api/booking/save-card AND as existingCustomerId on
   *  the final POST /api/square/bookings call. */
  customerId: string | null;
  /** Saved card_id from /api/booking/save-card. Present after the user
   *  successfully tokenizes a card on Step 4.5. */
  cardId: string | null;
  /** Charge amount in cents — service price snapshot taken at the time
   *  the card is saved. Used to prefill the policy callout and as the
   *  charge amount for late-cancel / no-show. */
  amountCents: number | null;
  /** Visible last-4 / brand for the post-capture confirmation row. */
  cardLast4: string | null;
  cardBrand: string | null;
  /** Customer ticked the "I understand my card will be charged…" box. */
  acknowledgedPolicy: boolean;
}

export interface WizardState {
  step: WizardStep;
  selectedService: Service | null;
  /**
   * The variation we'll book under. For shared-variation services this is
   * set when the user picks any barber (or "Any"). For per-barber services
   * it's set when the user picks a specific barber. When the user picks
   * "Any barber" on a per-barber service, this stays null until they pick
   * a slot — at which point we resolve it from the slot's variation id.
   */
  selectedVariation: ServiceVariation | null;
  /**
   * The variations we'll search availability against. Length 1 in the
   * normal case. Length > 1 only when the user chose "Any barber" on a
   * per-barber service — Step 3 fires one availability search per
   * candidate and merges the slots.
   */
  candidateVariations: ServiceVariation[];
  selectedBarber: Barber | null;
  /** True when the user picked "Any available barber" (no team filter on availability). */
  anyBarber: boolean;
  selectedSlot: AvailabilitySlot | null;
  /** Slot start_at strings the user has been told are unavailable — disable in step 3. */
  blockedSlots: string[];
  customer: CustomerInfo;
  status: WizardStatus;
  /** Phase 8 — card-on-file capture for new customers. */
  cardCapture: CardCaptureState;
  /** Book Ahead — when frequencyWeeks > 0, the wizard reserves
   *  state.selectedSlot AND every entry in series.generatedSlots in
   *  one Confirm. When frequencyWeeks === 0 (the default), behaves
   *  exactly like a single-visit booking. The generator runs the
   *  moment the customer picks a first slot with frequencyWeeks > 0
   *  set; UI lives in BookAheadCard / BookingPlanPanel. */
  series: SeriesState;
}

export type FrequencyWeeks = 0 | 2 | 3 | 4 | 6;
export type SeriesCount = 3 | 6 | 8;
export type GeneratedSlotStatus =
  /** Initial state before availability resolution finishes. */
  | 'pending'
  /** A real Square slot matches the intended date at the same wall-clock
   *  time as the first visit. Bookable as-is. */
  | 'available'
  /** Square returned slots for the day but none at the intended time —
   *  the barber's calendar already has something there. */
  | 'taken'
  /** Square returned no slots at all for the day (barber off, holiday,
   *  shop closed). */
  | 'barber-off'
  /** The intended date is past the booking horizon. */
  | 'out-of-horizon';

export interface GeneratedSlot {
  /** Wall-clock-matched intended start time in UTC. Stable across
   *  availability re-resolutions. */
  intendedStartAtUtc: string;
  status: GeneratedSlotStatus;
  /** The actual Square slot to book against. Set only when
   *  status === 'available'. */
  slot: AvailabilitySlot | null;
  /** Booking outcome after Confirm — populated per-slot as the submit
   *  loop runs so the success screen can show partial results. */
  bookingId?: string;
  bookingError?: string;
}

export interface SeriesState {
  frequencyWeeks: FrequencyWeeks;
  count: SeriesCount;
  /** Positions 2..N of the series. Position 1 is always
   *  state.selectedSlot (already a real Square AvailabilitySlot), so
   *  generatedSlots.length is at most count - 1. Empty when
   *  frequencyWeeks === 0. */
  generatedSlots: GeneratedSlot[];
  /** True while seriesAvailability is fetching/resolving the generated
   *  dates so the panel can show a spinner instead of stale data. */
  resolving: boolean;
}

export const initialCustomer: CustomerInfo = {
  givenName: '',
  familyName: '',
  email: '',
  phone: '',
  note: '',
  updateContact: false,
  marketingConsent: false,
};

export const initialSeries: SeriesState = {
  frequencyWeeks: 0,
  count: 3,
  generatedSlots: [],
  resolving: false,
};

export const initialCardCapture: CardCaptureState = {
  required: null,
  customerId: null,
  cardId: null,
  amountCents: null,
  cardLast4: null,
  cardBrand: null,
  acknowledgedPolicy: false,
};

export const initialState: WizardState = {
  step: 1,
  selectedService: null,
  selectedVariation: null,
  candidateVariations: [],
  selectedBarber: null,
  anyBarber: false,
  selectedSlot: null,
  blockedSlots: [],
  customer: initialCustomer,
  status: { kind: 'idle' },
  cardCapture: initialCardCapture,
  series: initialSeries,
};

export type WizardAction =
  | { type: 'SET_SERVICE'; service: Service }
  | { type: 'SET_BARBER'; barber: Barber; variation: ServiceVariation; anyBarber?: boolean }
  | { type: 'SET_ANY_BARBER'; variation: ServiceVariation }
  | { type: 'SET_ANY_BARBER_MULTI'; variations: ServiceVariation[] }
  | { type: 'SET_SLOT'; slot: AvailabilitySlot }
  | { type: 'BLOCK_SLOT'; startAtUtc: string }
  | { type: 'UPDATE_CUSTOMER'; patch: Partial<CustomerInfo> }
  | { type: 'GO_TO'; step: WizardStep }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'STATUS'; status: WizardStatus }
  | { type: 'UPDATE_CARD_CAPTURE'; patch: Partial<CardCaptureState> }
  /** Wipes every cardCapture field back to its initial value. Used
   *  when something invalidates the captured card — email/phone change
   *  (now a different person), or a Booking-for switch to a linked
   *  person. Without a full reset, a leftover cardId from one customer
   *  would silently get attached to a different customer's booking. */
  | { type: 'RESET_CARD_CAPTURE'; required?: boolean | null }
  | { type: 'SET_SERIES_FREQUENCY'; frequencyWeeks: FrequencyWeeks }
  | { type: 'SET_SERIES_COUNT'; count: SeriesCount }
  | { type: 'START_SERIES_RESOLVE' }
  | { type: 'SET_GENERATED_SLOTS'; slots: GeneratedSlot[] }
  | { type: 'REMOVE_GENERATED_SLOT'; intendedStartAtUtc: string }
  | { type: 'REPLACE_GENERATED_SLOT'; intendedStartAtUtc: string; replacement: AvailabilitySlot }
  | { type: 'MARK_GENERATED_SLOT_RESULT'; intendedStartAtUtc: string; bookingId?: string; bookingError?: string }
  /** "Book another visit" on the success screen — wipes the slot,
   *  service, barber, and status so the wizard goes back to Step 1
   *  ready for a fresh appointment, but KEEPS the customer's name,
   *  email, phone, and marketing consent so they don't retype on
   *  every visit. The customer is now established (they just booked
   *  one), so cardCapture pins to required:false to skip Step 4.5
   *  on subsequent visits in the same session. */
  | { type: 'START_ANOTHER_BOOKING' }
  | { type: 'RESET' };

export function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_SERVICE': {
      const sameService = state.selectedService?.id === action.service.id;
      if (sameService) {
        return { ...state, selectedService: action.service, step: 2 };
      }
      // New service. If a barber was already chosen (e.g. user came in via
      // /book?barber={id} from the home page) and is eligible for this
      // service, keep them and skip Step 2 entirely — otherwise the user
      // ends up picking the same barber twice.
      if (state.selectedBarber) {
        const variation = variationForBarber(action.service, state.selectedBarber.id);
        if (variation) {
          return {
            ...state,
            selectedService: action.service,
            selectedVariation: variation,
            candidateVariations: [variation],
            anyBarber: false,
            selectedSlot: null,
            blockedSlots: [],
            series: { ...state.series, generatedSlots: [], resolving: false },
            step: 3,
          };
        }
      }
      return {
        ...state,
        selectedService: action.service,
        selectedVariation: null,
        selectedBarber: null,
        anyBarber: false,
        selectedSlot: null,
        blockedSlots: [],
        candidateVariations: [],
        series: { ...state.series, generatedSlots: [], resolving: false },
        step: 2,
      };
    }
    case 'SET_BARBER':
      return {
        ...state,
        selectedBarber: action.barber,
        selectedVariation: action.variation,
        candidateVariations: [action.variation],
        anyBarber: action.anyBarber ?? false,
        selectedSlot: null,
        blockedSlots: [],
        series: { ...state.series, generatedSlots: [], resolving: false },
        step: 3,
      };
    case 'SET_ANY_BARBER':
      return {
        ...state,
        selectedBarber: null,
        selectedVariation: action.variation,
        candidateVariations: [action.variation],
        anyBarber: true,
        selectedSlot: null,
        blockedSlots: [],
        series: { ...state.series, generatedSlots: [], resolving: false },
        step: 3,
      };
    case 'SET_ANY_BARBER_MULTI':
      return {
        ...state,
        selectedBarber: null,
        // Defer variation selection until the slot is picked — that's
        // when we know which barber's calendar the slot came from.
        selectedVariation: null,
        candidateVariations: action.variations,
        anyBarber: true,
        selectedSlot: null,
        blockedSlots: [],
        series: { ...state.series, generatedSlots: [], resolving: false },
        step: 3,
      };
    case 'SET_SLOT': {
      // When multiple candidates were searched, resolve the variation
      // from the slot's serviceVariationId.
      const resolvedVariation =
        state.candidateVariations.length <= 1
          ? state.selectedVariation
          : (state.candidateVariations.find(
              (v) => v.id === action.slot.serviceVariationId,
            ) ?? state.selectedVariation);
      return {
        ...state,
        selectedSlot: action.slot,
        selectedVariation: resolvedVariation,
        // The generated series is keyed off the first-visit slot. A new
        // first slot means we need to regenerate from scratch; clear the
        // old list so Step 3's resolver can populate it fresh.
        series: { ...state.series, generatedSlots: [], resolving: false },
        step: 4,
      };
    }
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
    case 'UPDATE_CARD_CAPTURE':
      return { ...state, cardCapture: { ...state.cardCapture, ...action.patch } };
    case 'RESET_CARD_CAPTURE':
      return {
        ...state,
        cardCapture: {
          ...initialCardCapture,
          required: action.required === undefined ? null : action.required,
        },
      };
    case 'SET_SERIES_FREQUENCY':
      // Changing frequency invalidates any previously-generated slots —
      // every visit's date depends on the gap between visits.
      return {
        ...state,
        series: {
          ...state.series,
          frequencyWeeks: action.frequencyWeeks,
          generatedSlots: [],
          resolving: false,
        },
      };
    case 'SET_SERIES_COUNT':
      // Same — count drives how many slots we need to generate.
      return {
        ...state,
        series: {
          ...state.series,
          count: action.count,
          generatedSlots: [],
          resolving: false,
        },
      };
    case 'START_SERIES_RESOLVE':
      return { ...state, series: { ...state.series, resolving: true } };
    case 'SET_GENERATED_SLOTS':
      return {
        ...state,
        series: {
          ...state.series,
          generatedSlots: action.slots,
          resolving: false,
        },
      };
    case 'REMOVE_GENERATED_SLOT':
      return {
        ...state,
        series: {
          ...state.series,
          generatedSlots: state.series.generatedSlots.filter(
            (g) => g.intendedStartAtUtc !== action.intendedStartAtUtc,
          ),
        },
      };
    case 'REPLACE_GENERATED_SLOT':
      return {
        ...state,
        series: {
          ...state.series,
          generatedSlots: state.series.generatedSlots.map((g) =>
            g.intendedStartAtUtc === action.intendedStartAtUtc
              ? {
                  ...g,
                  status: 'available' as const,
                  slot: action.replacement,
                  intendedStartAtUtc: action.replacement.startAtUtc,
                }
              : g,
          ),
        },
      };
    case 'MARK_GENERATED_SLOT_RESULT':
      return {
        ...state,
        series: {
          ...state.series,
          generatedSlots: state.series.generatedSlots.map((g) =>
            g.intendedStartAtUtc === action.intendedStartAtUtc
              ? { ...g, bookingId: action.bookingId, bookingError: action.bookingError }
              : g,
          ),
        },
      };
    case 'START_ANOTHER_BOOKING':
      return {
        ...initialState,
        customer: {
          ...state.customer,
          // Per-appointment fields don't carry over.
          note: '',
        },
        cardCapture: {
          ...initialCardCapture,
          // Skip the new-customer check + Step 4.5 on subsequent
          // bookings in the same session — they just booked their
          // first visit, so by definition they're not new anymore.
          required: false,
        },
      };
    case 'RESET':
      return initialState;
  }
}

export function isStepReachable(state: WizardState, step: WizardStep, options?: { rescheduleMode?: boolean }): boolean {
  if (step <= 1) return true;
  if (step === 2) return state.selectedService !== null;
  if (step === 3) return state.selectedService !== null && state.candidateVariations.length > 0;
  if (step === 4) return state.selectedSlot !== null && state.selectedVariation !== null;
  if (step === 5) {
    if (state.selectedSlot === null || state.selectedVariation === null) return false;
    // In reschedule mode the customer record already exists — we only need
    // a valid slot + variation. Step 4 is skipped entirely.
    if (options?.rescheduleMode) return true;
    return customerInfoValid(state.customer);
  }
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

export function variationForBarber(service: Service, barberId: string): ServiceVariation | null {
  if (service.hasPerBarberVariations) {
    return service.variations.find((v) => v.eligibleTeamMemberIds.includes(barberId)) ?? null;
  }
  const v = service.variations[0];
  if (!v) return null;
  if (v.eligibleTeamMemberIds.length === 0) return v;
  return v.eligibleTeamMemberIds.includes(barberId) ? v : null;
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
