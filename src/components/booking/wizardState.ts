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
  /**
   * When the customer flips Step 4's "Who is this appointment for?"
   * radio to "Someone else", the kid's first name lives here. null
   * means "booking for me" — the existing single-record flow. When
   * present, the server creates (or matches via listLinkedPeople
   * dedupe) a kid customer record under the adult and books the
   * appointment under the kid. Adult fields (givenName/familyName/
   * email/phone) stay on the parent record so magic-link sign-in
   * still works for the parent.
   */
  bookingFor: { givenName: string } | null;
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
  /** Book Ahead — when desiredCount > 1, the customer is building
   *  a multi-visit plan by tapping slots from the live calendar.
   *  state.selectedSlot is always the first pick; every additional
   *  pick lands in series.pickedSlots. When desiredCount === 1
   *  (the default) the wizard behaves exactly like single-visit
   *  booking — pickedSlots stays empty.
   *
   *  Each pick is a real Square slot, never auto-generated; the
   *  prior cadence-based model was replaced because customers
   *  think in specific dates, not frequencies, and live picks
   *  guarantee availability at pick time (no resolution gap, no
   *  partial-failure recovery flow needed). */
  series: SeriesState;
}

export type DesiredCount = 1 | 2 | 3 | 4;

export interface SeriesState {
  /** How many visits the customer wants to book in this session.
   *  Default 1 (single visit). Capped at 4 — beyond that, decision
   *  fatigue compounds and the success-screen "Book ahead" CTA
   *  gives a clean path to additional visits via repetition. */
  desiredCount: DesiredCount;
  /** Picks in addition to state.selectedSlot. Length is at most
   *  desiredCount - 1. Plan is full when:
   *    selectedSlot !== null && pickedSlots.length === desiredCount - 1
   *  Order is pick order; rendering re-sorts chronologically. */
  pickedSlots: AvailabilitySlot[];
  /** Per-pick booking outcome after Confirm. Keyed by the slot's
   *  startAtUtc so it survives reordering. Populated as the submit
   *  loop runs so the success screen can render per-row status —
   *  a customer who sat on Step 5 long enough for a slot to get
   *  taken sees exactly which one failed instead of a vague
   *  "X of N" recap. */
  bookingResults: Record<string, { bookingId?: string; error?: string }>;
}

export const initialCustomer: CustomerInfo = {
  givenName: '',
  familyName: '',
  email: '',
  phone: '',
  note: '',
  updateContact: false,
  marketingConsent: false,
  bookingFor: null,
};

export const initialSeries: SeriesState = {
  desiredCount: 1,
  pickedSlots: [],
  bookingResults: {},
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
  /** Book Ahead — adjust how many visits the customer wants to
   *  book in this session. The reducer reconciles when the new
   *  count is smaller than the current pick total: most-recently-
   *  added pickedSlots are dropped to fit. The Step 3 component
   *  surfaces a toast describing the drop so the change isn't
   *  silent. */
  | { type: 'SET_DESIRED_COUNT'; desiredCount: DesiredCount }
  /** Book Ahead — append a pick after the customer has already
   *  set a selectedSlot (the first pick goes through SET_SLOT).
   *  No-op if the pick would overflow desiredCount or duplicate
   *  an existing pick (defense in depth — the slot grid disables
   *  already-picked times). */
  | { type: 'ADD_PICKED_SLOT'; slot: AvailabilitySlot }
  /** Book Ahead — drop a pick from the plan. Matches by exact
   *  startAtUtc. If the removed slot is state.selectedSlot, the
   *  next-earliest pickedSlot is promoted into selectedSlot so
   *  downstream wizard code (which reads selectedSlot for the
   *  first booking's payload) stays in shape. */
  | { type: 'REMOVE_PICKED_SLOT'; startAtUtc: string }
  /** Book Ahead — record a per-pick booking outcome as the
   *  submit loop progresses. Used by the success screen to show
   *  Confirmed / Failed badges on each row. */
  | { type: 'MARK_PICK_RESULT'; startAtUtc: string; bookingId?: string; error?: string }
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
            series: { ...state.series, pickedSlots: [], bookingResults: {} },
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
        series: { ...state.series, pickedSlots: [], bookingResults: {} },
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
        series: { ...state.series, pickedSlots: [], bookingResults: {} },
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
        series: { ...state.series, pickedSlots: [], bookingResults: {} },
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
        series: { ...state.series, pickedSlots: [], bookingResults: {} },
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
        series: { ...state.series, pickedSlots: [], bookingResults: {} },
        // For single-visit bookings we auto-advance. For Book Ahead
        // series, stay on Step 3 so the customer sees the plan panel
        // assemble below the calendar — without this, picking a slot
        // jumped straight to Step 4 (customer info) and the customer
        // never saw the series being built. They'd hit Confirm before
        // resolution finished and only the first visit would land.
        step: state.series.desiredCount > 1 ? 3 : 4,
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
    case 'SET_DESIRED_COUNT': {
      // Reconcile when the new count drops below the existing pick
      // total. Most-recently-added pickedSlots get truncated; the
      // first pick (state.selectedSlot) is preserved unless the
      // customer drops back to count=1 from a state with extras —
      // in which case selectedSlot still stays (it's their first
      // pick, the one they most likely want), and only the extras
      // disappear. The Step 3 component watches the diff and shows
      // a toast so the change isn't silent.
      const maxExtras = action.desiredCount - 1;
      const trimmedExtras = state.series.pickedSlots.slice(0, Math.max(0, maxExtras));
      // Trim bookingResults to match the surviving picks so a
      // stale "Confirmed" badge from a previously-dropped slot
      // can't leak into the success screen.
      const survivingKeys = new Set([
        ...(state.selectedSlot ? [state.selectedSlot.startAtUtc] : []),
        ...trimmedExtras.map((s) => s.startAtUtc),
      ]);
      const trimmedResults = Object.fromEntries(
        Object.entries(state.series.bookingResults).filter(([k]) => survivingKeys.has(k)),
      );
      return {
        ...state,
        series: {
          desiredCount: action.desiredCount,
          pickedSlots: trimmedExtras,
          bookingResults: trimmedResults,
        },
      };
    }
    case 'ADD_PICKED_SLOT': {
      // Defense-in-depth — the slot grid disables already-picked
      // times, but we also refuse duplicates and overflow here so
      // a programmatic dispatch can't corrupt the plan.
      const alreadyHave =
        state.selectedSlot?.startAtUtc === action.slot.startAtUtc ||
        state.series.pickedSlots.some((s) => s.startAtUtc === action.slot.startAtUtc);
      if (alreadyHave) return state;
      const planLen = (state.selectedSlot ? 1 : 0) + state.series.pickedSlots.length;
      if (planLen >= state.series.desiredCount) return state;
      return {
        ...state,
        series: {
          ...state.series,
          pickedSlots: [...state.series.pickedSlots, action.slot],
        },
      };
    }
    case 'REMOVE_PICKED_SLOT': {
      // Removing the primary slot (state.selectedSlot) promotes the
      // earliest extra into selectedSlot so downstream code that
      // reads selectedSlot stays in shape. If there are no extras,
      // selectedSlot just clears.
      if (state.selectedSlot?.startAtUtc === action.startAtUtc) {
        const extras = state.series.pickedSlots;
        if (extras.length === 0) {
          return { ...state, selectedSlot: null };
        }
        const sortedExtras = [...extras].sort(
          (a, b) => Date.parse(a.startAtUtc) - Date.parse(b.startAtUtc),
        );
        const promoted = sortedExtras[0];
        return {
          ...state,
          selectedSlot: promoted,
          series: {
            ...state.series,
            pickedSlots: extras.filter((s) => s.startAtUtc !== promoted.startAtUtc),
          },
        };
      }
      return {
        ...state,
        series: {
          ...state.series,
          pickedSlots: state.series.pickedSlots.filter(
            (s) => s.startAtUtc !== action.startAtUtc,
          ),
        },
      };
    }
    case 'MARK_PICK_RESULT':
      return {
        ...state,
        series: {
          ...state.series,
          bookingResults: {
            ...state.series.bookingResults,
            [action.startAtUtc]: {
              bookingId: action.bookingId,
              error: action.error,
            },
          },
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
  // When "Someone else" is selected, the kid's first name is also
  // required. Last name is optional in v1.
  if (c.bookingFor && !c.bookingFor.givenName.trim()) return false;
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
