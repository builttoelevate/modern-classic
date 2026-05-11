import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Barber, Location, Service, ServiceVariation, AvailabilitySlot } from '../../lib/square/types';
import { Step1ServicePicker } from './Step1ServicePicker';
import { Step2BarberPicker } from './Step2BarberPicker';
import { Step3DateTimePicker } from './Step3DateTimePicker';
import { Step4CustomerInfo } from './Step4CustomerInfo';
import { Step5Confirm } from './Step5Confirm';
import { Step45CardCapture } from './Step45CardCapture';
import { buildSeriesNote, newSeriesId } from '../../lib/booking/series';
import {
  initialState as defaultInitialState,
  reducer,
  isStepReachable,
  digits,
  type WizardState,
  type WizardStep,
} from './wizardState';
import type { CreateBookingResponse } from '../../lib/booking/types';

export interface RescheduleContext {
  oldBookingId: string;
  oldBookingVersion: number;
  oldStartAtUtc: string;
  oldStartAtLocal: string;
  serviceVariationId: string;
  teamMemberId: string;
  customerEmail: string;
  customerGivenName?: string;
  customerFamilyName?: string;
}

export interface WizardPreselectProps {
  serviceVariationId?: string;
  teamMemberId?: string;
}

export interface SignedInCustomer {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
}

/** Entries for the "Booking for" selector at the top of the wizard.
 * First entry must be the signed-in customer themselves (isSelf: true);
 * additional entries are people they've linked via /profile so they can
 * book on someone else's behalf. */
export interface BookingForOption {
  customerId: string;
  displayName: string;
  relationship?: string;
  isSelf: boolean;
}

interface Props {
  services: Service[];
  barbers: Barber[];
  location: Location | null;
  reschedule?: RescheduleContext;
  preselect?: WizardPreselectProps;
  /** When set, the wizard skips Step 4 (Details) — the customer is signed
   * in and we already have all four contact fields. */
  signedInCustomer?: SignedInCustomer;
  /** Self + linked people list. Selector hides if length <= 1. */
  bookingForOptions?: BookingForOption[];
}

const STEP_LABELS = ['Service', 'Barber', 'Time', 'Details', 'Confirm'];
const RESCHEDULE_STEP_LABELS = ['Time', 'Confirm'];

function estimatedTimeRemaining(step: WizardStep): string {
  const map: Record<WizardStep, string> = {
    1: 'About 1 min',
    2: 'About 1 min',
    3: 'About 45 sec',
    4: 'About 30 sec',
    5: '15 sec',
  };
  return map[step];
}

function priceCentsForBooking(
  service: Service | null,
  variation: ServiceVariation | null,
): number {
  // Fixed-price variation: use it directly. Variable-price (or unknown):
  // fall back to the service's max so the no-show charge represents the
  // worst-case exposure rather than something arbitrarily small. If we
  // somehow have nothing, fall back to $45 (Modern Classic's typical
  // standard cut). The card-capture form surfaces this number in the
  // policy callout so the customer always knows the ceiling.
  if (variation?.priceCents !== null && variation?.priceCents !== undefined) {
    return variation.priceCents;
  }
  if (service?.maxPriceCents !== null && service?.maxPriceCents !== undefined) {
    return service.maxPriceCents;
  }
  if (service?.minPriceCents !== null && service?.minPriceCents !== undefined) {
    return service.minPriceCents;
  }
  return 4500;
}

function priceDisplayForBooking(
  service: Service | null,
  variation: ServiceVariation | null,
): string {
  const cents = priceCentsForBooking(service, variation);
  return `$${(cents / 100).toFixed(0)}`;
}

function buildPreselectInitialState(
  pre: WizardPreselectProps,
  services: Service[],
  barbers: Barber[],
): WizardState | null {
  if (!pre.serviceVariationId && !pre.teamMemberId) return null;

  // Find the variation if specified.
  let foundService: Service | null = null;
  let foundVariation: ServiceVariation | null = null;
  if (pre.serviceVariationId) {
    for (const s of services) {
      const v = s.variations.find((vv) => vv.id === pre.serviceVariationId);
      if (v) {
        foundService = s;
        foundVariation = v;
        break;
      }
    }
  }
  const foundBarber = pre.teamMemberId
    ? barbers.find((b) => b.id === pre.teamMemberId) ?? null
    : null;

  // Case A: both service + barber → land on Step 3 (Date/Time) directly.
  if (foundService && foundVariation && foundBarber) {
    return {
      ...defaultInitialState,
      step: 3,
      selectedService: foundService,
      selectedVariation: foundVariation,
      candidateVariations: [foundVariation],
      selectedBarber: foundBarber,
      anyBarber: false,
    };
  }

  // Case B: service only → land on Step 2 (Barber) with the service set.
  if (foundService && foundVariation && !foundBarber) {
    return {
      ...defaultInitialState,
      step: 2,
      selectedService: foundService,
      selectedVariation: foundVariation,
      candidateVariations: [foundVariation],
    };
  }

  // Case C: barber only → stay on Step 1 (Service), but remember the
  // barber so when they pick a service we can pin to the matching
  // variation. We do that by setting selectedBarber early; the reducer
  // will overwrite as the user advances.
  if (!foundService && foundBarber) {
    return {
      ...defaultInitialState,
      step: 1,
      selectedBarber: foundBarber,
    };
  }
  return null;
}

function buildRescheduleInitialState(
  ctx: RescheduleContext,
  services: Service[],
  barbers: Barber[],
): WizardState | null {
  let foundService: Service | null = null;
  let foundVariation: ServiceVariation | null = null;
  for (const s of services) {
    const v = s.variations.find((vv) => vv.id === ctx.serviceVariationId);
    if (v) {
      foundService = s;
      foundVariation = v;
      break;
    }
  }
  if (!foundService || !foundVariation) return null;
  const foundBarber = barbers.find((b) => b.id === ctx.teamMemberId) ?? null;

  return {
    ...defaultInitialState,
    step: 3,
    selectedService: foundService,
    selectedVariation: foundVariation,
    candidateVariations: [foundVariation],
    selectedBarber: foundBarber,
    anyBarber: false,
    selectedSlot: null,
    blockedSlots: [],
    customer: {
      ...defaultInitialState.customer,
      email: ctx.customerEmail,
      givenName: ctx.customerGivenName ?? '',
      familyName: ctx.customerFamilyName ?? '',
    },
  };
}

function isCompleteCustomer(c: SignedInCustomer | undefined): c is SignedInCustomer {
  if (!c) return false;
  return (
    c.givenName.trim().length > 0 &&
    c.familyName.trim().length > 0 &&
    /^\S+@\S+\.\S+$/.test(c.email.trim()) &&
    digits(c.phone).length >= 10
  );
}

export default function BookingWizard({
  services,
  barbers,
  location,
  reschedule,
  preselect,
  signedInCustomer,
  bookingForOptions,
}: Props) {
  // "Booking for" selector — currently selected customerId. Defaults to
  // self (the first option). When the parent picks a linked person, we
  // override the booking's customerId at submit time so the appointment
  // is created under THAT person's Square record (their name is what
  // shows on Square's reminder text + the seller dashboard).
  const showBookingForSelector = !!bookingForOptions && bookingForOptions.length > 1 && !reschedule;
  const [bookingForId, setBookingForId] = useState<string>(
    showBookingForSelector ? (bookingForOptions![0]?.customerId ?? '') : '',
  );
  const selectedBookingFor =
    bookingForOptions?.find((o) => o.customerId === bookingForId) ?? null;
  const skipDetailsStep = isCompleteCustomer(signedInCustomer);
  const initialState = useMemo<WizardState>(() => {
    let base: WizardState;
    if (reschedule) {
      base = buildRescheduleInitialState(reschedule, services, barbers) ?? defaultInitialState;
    } else if (preselect && (preselect.serviceVariationId || preselect.teamMemberId)) {
      base = buildPreselectInitialState(preselect, services, barbers) ?? defaultInitialState;
    } else {
      base = defaultInitialState;
    }
    // Pre-fill the customer info from the signed-in session so the
    // submit step has everything it needs without Step 4 collecting it
    // a second time. Reschedule mode already pre-fills via its own ctx;
    // we only patch missing fields here so it doesn't overwrite the
    // reschedule's known-good values.
    if (signedInCustomer) {
      base = {
        ...base,
        customer: {
          ...base.customer,
          givenName: base.customer.givenName || signedInCustomer.givenName,
          familyName: base.customer.familyName || signedInCustomer.familyName,
          email: base.customer.email || signedInCustomer.email,
          phone: base.customer.phone || signedInCustomer.phone,
        },
      };
    }
    // Anyone we already know is a returning customer can skip the
    // new-customer card-capture check entirely:
    //   - Reschedule mode: the booking is being moved, the customer
    //     existed before today.
    //   - Signed-in customer: they have an authenticated session, so
    //     they've booked at some point in the past.
    // Guest checkout stays cardCapture.required = null so the wizard
    // fires /api/booking/check-new-customer on entry to Step 5.
    if (reschedule || signedInCustomer) {
      base = {
        ...base,
        cardCapture: { ...base.cardCapture, required: false },
      };
    }
    return base;
  }, [reschedule, preselect, services, barbers, signedInCustomer]);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [toast, setToast] = useState<string | null>(null);
  const rescheduleMode = !!reschedule;

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // Scroll to the top of the wizard whenever the step changes. The
  // lastScrolledStepRef guard avoids scrolling on the very first render
  // (state.step == initialState.step). Honors prefers-reduced-motion.
  const wizardRootRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledStepRef = useRef<number>(initialState.step);
  useEffect(() => {
    if (lastScrolledStepRef.current === state.step) return;
    lastScrolledStepRef.current = state.step;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
    if (wizardRootRef.current) {
      wizardRootRef.current.scrollIntoView({ behavior, block: 'start' });
    } else if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior });
    }
  }, [state.step]);

  // Keyboard nav: Esc goes back; Enter submits when valid (handled in form).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.step > 1 && state.status.kind !== 'submitting') {
        // Don't pull focus out of inputs unexpectedly.
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        dispatch({ type: 'BACK' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.step, state.status]);

  // Reschedule mode skips step 4 (Customer info) — auto-advance to 5
  // whenever the reducer lands on 4. Going BACK from step 5 lands here
  // too, so we redirect again to step 3.
  useEffect(() => {
    if (!rescheduleMode) return;
    if (state.step !== 4) return;
    if (state.status.kind === 'submitting') return;
    if (state.selectedSlot && state.selectedVariation) {
      dispatch({ type: 'GO_TO', step: 5 });
    } else {
      dispatch({ type: 'GO_TO', step: 3 });
    }
  }, [state.step, rescheduleMode, state.selectedSlot, state.selectedVariation, state.status.kind]);

  // "Booking for" linked person: the parent (signed in) is paying / on
  // file, so we never card-capture the linked person even if their own
  // Square record has no booking history yet. Pin cardCapture.required
  // to false the moment the parent flips the selector to a non-self
  // option, and back to whatever it was when they switch back.
  //
  // We do a FULL reset (not just required:false) because the user may
  // already have captured a card under their own name and we don't
  // want that cardId leaking into a booking now intended for a kid.
  const bookingForLockedReturning = !!selectedBookingFor && !selectedBookingFor.isSelf;
  useEffect(() => {
    if (bookingForLockedReturning && state.cardCapture.required !== false) {
      dispatch({ type: 'RESET_CARD_CAPTURE', required: false });
    }
  }, [bookingForLockedReturning, state.cardCapture.required]);

  // Step 5 entry — fire /api/booking/check-new-customer once we have
  // the customer's email + phone, unless we already know they're
  // returning (reschedule, signed-in, booking-for-linked-person). Reset
  // when the customer's email/phone changes (Step 4 edits) so we don't
  // serve a stale verdict if they swap to a different account.
  const customerEmail = state.customer.email.trim().toLowerCase();
  const customerPhoneDigits = digits(state.customer.phone);
  const checkSentRef = useRef<string | null>(null);
  useEffect(() => {
    // Different email/phone = different person → cardCapture verdict,
    // customerId, AND any captured card all belong to the previous
    // person. Wipe the whole substate. Without a full reset, a stale
    // cardId would still be present after the new check-new-customer
    // run sets a new customerId — and showCardCapture's
    // !state.cardCapture.cardId guard would short-circuit, sending the
    // OLD card_id alongside the NEW customer_id to the booking endpoint.
    checkSentRef.current = null;
    if (!rescheduleMode && !signedInCustomer && !bookingForLockedReturning) {
      dispatch({ type: 'RESET_CARD_CAPTURE' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerEmail, customerPhoneDigits]);

  useEffect(() => {
    if (state.step !== 5) return;
    if (rescheduleMode || signedInCustomer || bookingForLockedReturning) return;
    if (state.cardCapture.required !== null) return;
    if (!/^\S+@\S+\.\S+$/.test(customerEmail)) return;
    if (customerPhoneDigits.length < 10) return;
    if (!state.customer.givenName.trim() || !state.customer.familyName.trim()) return;
    const key = `${customerEmail}|${customerPhoneDigits}`;
    if (checkSentRef.current === key) return;
    checkSentRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/booking/check-new-customer', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: customerEmail,
            phone: customerPhoneDigits,
            givenName: state.customer.givenName.trim(),
            familyName: state.customer.familyName.trim(),
          }),
        });
        const body = (await res.json()) as
          | { ok: true; newCustomer: boolean; customerId: string }
          | { ok: false; error: { code: string; detail: string } };
        if (cancelled) return;
        if (!res.ok || !body.ok) {
          // Fail-soft: if the check itself errors, treat as returning.
          // The cancellation policy keeps its existing "call the shop"
          // behavior; better than blocking the booking entirely.
          dispatch({
            type: 'UPDATE_CARD_CAPTURE',
            patch: { required: false, customerId: null },
          });
          return;
        }
        dispatch({
          type: 'UPDATE_CARD_CAPTURE',
          patch: {
            required: body.newCustomer,
            customerId: body.customerId,
            amountCents: priceCentsForBooking(state.selectedService, state.selectedVariation),
          },
        });
      } catch {
        if (cancelled) return;
        dispatch({
          type: 'UPDATE_CARD_CAPTURE',
          patch: { required: false, customerId: null },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    state.step,
    rescheduleMode,
    signedInCustomer,
    bookingForLockedReturning,
    state.cardCapture.required,
    customerEmail,
    customerPhoneDigits,
    state.customer.givenName,
    state.customer.familyName,
    state.selectedService,
    state.selectedVariation,
  ]);

  // Signed-in customers with a complete contact record on file skip the
  // Details step too — same auto-advance pattern as reschedule mode.
  // Going BACK from Step 5 lands here, so we redirect again to Step 3.
  useEffect(() => {
    if (!skipDetailsStep) return;
    if (rescheduleMode) return;
    if (state.step !== 4) return;
    if (state.status.kind === 'submitting') return;
    if (state.selectedSlot && state.selectedVariation) {
      dispatch({ type: 'GO_TO', step: 5 });
    } else {
      dispatch({ type: 'GO_TO', step: 3 });
    }
  }, [
    state.step,
    skipDetailsStep,
    rescheduleMode,
    state.selectedSlot,
    state.selectedVariation,
    state.status.kind,
  ]);

  const submit = async () => {
    if (!state.selectedService || !state.selectedVariation || !state.selectedSlot) return;
    const teamMemberId = state.anyBarber
      ? state.selectedSlot.teamMemberId
      : state.selectedBarber?.id;
    if (!teamMemberId) return;

    dispatch({ type: 'STATUS', status: { kind: 'submitting' } });

    let body: CreateBookingResponse;
    let networkError = false;
    // Book Ahead — every booking in a series carries the same
    // mc-srs-XXXX id in its customer note (parallel to the group
    // preamble). The id is generated once per submit and reused
    // across the first booking + every extra in the series loop
    // below. Hoisted to function scope so both the initial-submit
    // branch (where it's set) and the post-success series loop
    // (where it's read) can see it. Reschedule mode never sets
    // these — that branch doesn't carry a series.
    const isSeriesSubmit =
      !rescheduleMode && state.series.desiredCount > 1 && state.series.pickedSlots.length > 0;
    const seriesId = isSeriesSubmit ? newSeriesId() : null;
    // Total = first booking + every extra in the plan. We don't pin
    // to desiredCount here because the customer might have advanced
    // with fewer than they originally asked for (the Continue button
    // only enables when the plan is full, but reducer-level changes
    // could trim mid-flight).
    const seriesTotal = isSeriesSubmit ? 1 + state.series.pickedSlots.length : 0;

    if (rescheduleMode && reschedule) {
      const reschedulePayload = {
        oldBookingId: reschedule.oldBookingId,
        newSlot: { startAtUtc: state.selectedSlot.startAtUtc },
        service: {
          variationId: state.selectedVariation.id,
          version: state.selectedVariation.version,
          durationMinutes: state.selectedVariation.durationMinutes,
        },
        barber: { id: teamMemberId },
        customerNote: state.customer.note.trim() || undefined,
      };
      try {
        const res = await fetch('/api/square/bookings/reschedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(reschedulePayload),
        });
        const data = (await res.json()) as
          | { ok: true; newBookingId: string; oldBookingId: string; warning?: string }
          | { ok: false; error: { code: string; detail: string; slotTaken?: boolean } };
        if ('ok' in data && data.ok) {
          body = {
            ok: true,
            bookingId: data.newBookingId,
            customerId: '',
            startAtUtc: state.selectedSlot.startAtUtc,
          };
        } else {
          body = {
            ok: false,
            error: {
              code: data.error.code,
              detail: data.error.detail,
              slotTaken: data.error.slotTaken,
            },
          };
        }
      } catch {
        networkError = true;
        body = {
          ok: false,
          error: { code: 'NETWORK_ERROR', detail: 'Network request failed' },
        };
      }
    } else {
      // If the parent picked a linked person from the "Booking for"
      // selector, route the booking under that person's Square customer
      // record. The form's own givenName/familyName fields stay set to
      // the linked person's display name so the success screen + Square
      // dashboard read consistently.
      const overrideCustomerId =
        selectedBookingFor && !selectedBookingFor.isSelf
          ? selectedBookingFor.customerId
          : undefined;
      const overrideName = selectedBookingFor && !selectedBookingFor.isSelf
        ? selectedBookingFor.displayName.split(' ')
        : null;
      // For a guest checkout we do NOT send existingCustomerId — the
      // server will findOrCreate by email and pick up the same record
      // check-new-customer resolved (it matches by email too). This
      // closes a hole where a hostile guest could supply any known
      // Square customerId and book under it. The "Booking for" linked-
      // person path is the only legit reason to send the field, and
      // that path has its own server-side ownership check.
      const cardOnFilePayload =
        state.cardCapture.required && state.cardCapture.cardId && state.cardCapture.amountCents
          ? {
              cardId: state.cardCapture.cardId,
              amountCents: state.cardCapture.amountCents,
            }
          : undefined;
      // Build the first booking's customer note. For a series the
      // marker stamps every booking with the same series id so a
      // future admin/log can stitch them back. The customer's typed
      // note only rides along on the first visit — "first time,
      // please go easy" doesn't apply to visit 3.
      const firstNote = isSeriesSubmit && seriesId
        ? buildSeriesNote({
            seriesId,
            position: 1,
            total: seriesTotal,
            userNote: state.customer.note,
          })
        : state.customer.note.trim() || undefined;
      const payload = {
        service: {
          variationId: state.selectedVariation.id,
          version: state.selectedVariation.version,
          durationMinutes: state.selectedVariation.durationMinutes,
          name: state.selectedService.name,
          priceDisplay: priceFormat(state.selectedService, state.selectedVariation),
        },
        barber: {
          id: teamMemberId,
          name: state.selectedBarber?.displayName ?? 'First available',
        },
        slot: { startAtUtc: state.selectedSlot.startAtUtc },
        customer: {
          givenName: overrideName ? overrideName[0] : state.customer.givenName.trim(),
          familyName: overrideName ? overrideName.slice(1).join(' ') : state.customer.familyName.trim(),
          email: state.customer.email.trim(),
          phone: digits(state.customer.phone),
          note: firstNote,
          updateContact: overrideCustomerId ? false : state.customer.updateContact,
          marketingConsent: overrideCustomerId ? false : state.customer.marketingConsent,
        },
        existingCustomerId: overrideCustomerId,
        cardOnFile: cardOnFilePayload,
      };

      try {
        const res = await fetch('/api/square/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        body = (await res.json()) as CreateBookingResponse;
      } catch {
        networkError = true;
        body = {
          ok: false,
          error: { code: 'NETWORK_ERROR', detail: 'Network request failed' },
        };
      }
    }

    if (networkError) {
      dispatch({
        type: 'STATUS',
        status: {
          kind: 'error',
          message:
            "We're not sure if your booking went through. Please check your email or call us at 740-297-4462 before retrying.",
        },
      });
      return;
    }

    if (body.ok) {
      // Book Ahead — after the first visit lands, fire the rest of
      // the series in parallel under the same Square customer record.
      // Each subsequent booking carries existingCustomerId so the
      // server skips findOrCreate. Per-visit failures don't abort the
      // batch; the success screen surfaces the partial result so the
      // customer can re-pick the conflicted ones later.
      if (
        isSeriesSubmit &&
        seriesId &&
        state.selectedService &&
        state.selectedVariation
      ) {
        // Mark the first booking's outcome too — the success screen
        // reads bookingResults to render Confirmed/Failed badges
        // per row, and the first visit's the same as any other in
        // the customer's eyes.
        if (state.selectedSlot) {
          dispatch({
            type: 'MARK_PICK_RESULT',
            startAtUtc: state.selectedSlot.startAtUtc,
            bookingId: body.bookingId,
          });
        }
        const resolvedCustomerId = body.customerId;
        if (resolvedCustomerId) {
          const seriesCardOnFile =
            state.cardCapture.cardId && state.cardCapture.amountCents
              ? {
                  cardId: state.cardCapture.cardId,
                  amountCents: state.cardCapture.amountCents,
                }
              : undefined;
          // Iterate the extras in pick order. Position is derived
          // from the slot's chronological place in the full plan
          // (sorted), not pick order, so the customer-note marker
          // reads sensibly.
          const allInOrder = [
            state.selectedSlot,
            ...state.series.pickedSlots,
          ]
            .filter((s): s is NonNullable<typeof s> => s !== null)
            .slice()
            .sort((a, b) => Date.parse(a.startAtUtc) - Date.parse(b.startAtUtc));
          const positionOf = (startAtUtc: string): number =>
            allInOrder.findIndex((s) => s.startAtUtc === startAtUtc) + 1;
          // Sequential, stop-on-failure. A race condition on
          // visit 3 shouldn't quietly cascade into a half-booked
          // plan — the customer sees "visits 1-2 booked, visit 3
          // couldn't be booked, 4 not attempted" instead.
          for (const slot of state.series.pickedSlots) {
            const extraPayload = {
              service: {
                variationId: state.selectedVariation!.id,
                version: state.selectedVariation!.version,
                durationMinutes: state.selectedVariation!.durationMinutes,
                name: state.selectedService!.name,
                priceDisplay: priceFormat(
                  state.selectedService!,
                  state.selectedVariation!,
                ),
              },
              barber: {
                id: teamMemberId,
                name: state.selectedBarber?.displayName ?? 'First available',
              },
              slot: { startAtUtc: slot.startAtUtc },
              customer: {
                givenName: state.customer.givenName.trim(),
                familyName: state.customer.familyName.trim(),
                email: state.customer.email.trim(),
                phone: digits(state.customer.phone),
                note: buildSeriesNote({
                  seriesId,
                  position: positionOf(slot.startAtUtc),
                  total: seriesTotal,
                }),
                // The first booking already wrote whatever contact /
                // marketing-consent diff the customer cared about;
                // don't replay it on every series visit.
                updateContact: false,
                marketingConsent: false,
              },
              existingCustomerId: resolvedCustomerId,
              cardOnFile: seriesCardOnFile,
            };
            let visitFailed = false;
            try {
              const res = await fetch('/api/square/bookings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(extraPayload),
              });
              const data = (await res.json()) as CreateBookingResponse;
              if (data.ok) {
                dispatch({
                  type: 'MARK_PICK_RESULT',
                  startAtUtc: slot.startAtUtc,
                  bookingId: data.bookingId,
                });
              } else {
                dispatch({
                  type: 'MARK_PICK_RESULT',
                  startAtUtc: slot.startAtUtc,
                  error: data.error?.detail ?? 'Could not book this visit.',
                });
                visitFailed = true;
              }
            } catch {
              dispatch({
                type: 'MARK_PICK_RESULT',
                startAtUtc: slot.startAtUtc,
                error: 'Network error on this visit.',
              });
              visitFailed = true;
            }
            if (visitFailed) break;
          }
        }
      }

      dispatch({
        type: 'STATUS',
        status: {
          kind: 'success',
          bookingId: body.bookingId,
          emailDestination: state.customer.email.trim(),
        },
      });
      return;
    }

    const err = body.error;
    if (err.slotTaken) {
      // Phase 4 A.2 — block the slot and bounce to step 3.
      if (state.selectedSlot) {
        dispatch({ type: 'BLOCK_SLOT', startAtUtc: state.selectedSlot.startAtUtc });
      }
      dispatch({ type: 'GO_TO', step: 3 });
      dispatch({ type: 'STATUS', status: { kind: 'idle' } });
      setToast('That slot was just taken. Please pick another.');
      return;
    }
    if (err.leadTimeTooShort) {
      // Phase 4 A.3 — slot is below Michael's minimum lead time.
      if (state.selectedSlot) {
        dispatch({ type: 'BLOCK_SLOT', startAtUtc: state.selectedSlot.startAtUtc });
      }
      dispatch({ type: 'GO_TO', step: 3 });
      dispatch({ type: 'STATUS', status: { kind: 'idle' } });
      setToast("Sorry, that's too soon. Please pick a later time.");
      return;
    }

    const friendly = friendlyError(err.code, err.detail);
    dispatch({
      type: 'STATUS',
      status: {
        kind: 'error',
        message: friendly,
        slotTaken: err.slotTaken,
        leadTimeTooShort: err.leadTimeTooShort,
      },
    });
  };

  const teamMemberId = state.anyBarber ? undefined : state.selectedBarber?.id;

  // True when the wizard is on Step 5 but the new-customer card has not
  // yet been captured — in that case render the card form instead of
  // the confirm summary. Once cardCapture.cardId is set, we fall
  // through to the normal Step 5 confirm UI.
  const showCardCapture =
    state.step === 5 &&
    state.cardCapture.required === true &&
    !state.cardCapture.cardId &&
    !!state.cardCapture.customerId;

  const rescheduleStepIndex = (() => {
    // For the progress bar: in reschedule mode we only show steps 3 and 5.
    if (state.step === 3) return 1;
    if (state.step === 5) return 2;
    return 1;
  })();
  // Signed-in customers skip Step 4 (Details) — relabel the progress bar
  // so "STEP X of 4" is honest. Step 5 (Confirm) becomes "Step 4".
  const skippedDetailsLabels = ['Service', 'Barber', 'Time', 'Confirm'];
  const skippedStepIndex = state.step === 5 ? 4 : state.step;
  // Card-capture inserts a virtual extra step between Details and
  // Confirm — only count it when the wizard knows it's required.
  const cardStepCount = state.cardCapture.required === true ? 1 : 0;
  const totalSteps = (rescheduleMode ? 2 : skipDetailsStep ? 4 : 5) + cardStepCount;
  const currentStep = rescheduleMode
    ? rescheduleStepIndex
    : skipDetailsStep
      ? skippedStepIndex + (showCardCapture ? 1 : 0)
      : showCardCapture
        ? 5
        : state.step + (state.step === 5 ? cardStepCount : 0);
  const stepLabel = rescheduleMode
    ? RESCHEDULE_STEP_LABELS[rescheduleStepIndex - 1]
    : showCardCapture
      ? 'Card'
      : skipDetailsStep
        ? skippedDetailsLabels[skippedStepIndex - 1] ?? STEP_LABELS[state.step - 1]
        : STEP_LABELS[state.step - 1];

  return (
    <div className="bw" ref={wizardRootRef}>
      {toast && (
        <div className="bw-toast" role="status">
          {toast}
        </div>
      )}

      <div className="bw-head">
        {rescheduleMode ? (
          <>
            <h1>Reschedule your appointment</h1>
            <p>
              Pick a new time — your service and barber are already selected. We'll cancel the
              old slot once the new one is locked in.
            </p>
          </>
        ) : (
          <>
            <h1>Book your appointment</h1>
            <p>Five quick steps. Real-time availability from Square.</p>
          </>
        )}
      </div>

      {rescheduleMode && reschedule && state.step === 5 && state.selectedSlot && (
        <div className="bw-reschedule-banner" role="region" aria-label="Reschedule summary">
          <div className="bw-reschedule-banner__row">
            <span className="bw-reschedule-banner__label">From</span>
            <span className="bw-reschedule-banner__value">{reschedule.oldStartAtLocal}</span>
          </div>
          <div className="bw-reschedule-banner__arrow" aria-hidden="true">→</div>
          <div className="bw-reschedule-banner__row">
            <span className="bw-reschedule-banner__label">To</span>
            <span className="bw-reschedule-banner__value">
              {formatLocalEt(state.selectedSlot.startAtUtc)}
            </span>
          </div>
        </div>
      )}

      {showBookingForSelector && bookingForOptions && (
        <div className="bw-bookfor" role="group" aria-label="Who is this appointment for?">
          <label htmlFor="bw-bookfor-select" className="bw-bookfor__label">
            Booking for
          </label>
          <select
            id="bw-bookfor-select"
            className="bw-bookfor__select"
            value={bookingForId}
            onChange={(e) => setBookingForId(e.target.value)}
          >
            {bookingForOptions.map((opt) => (
              <option key={opt.customerId} value={opt.customerId}>
                {opt.isSelf ? `Me — ${opt.displayName}` : opt.displayName}
                {!opt.isSelf && opt.relationship ? ` (${opt.relationship})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="bw-progress" aria-label={`Step ${currentStep} of ${totalSteps}`}>
        <span className="bw-progress-label">
          Step {currentStep} of {totalSteps} · {stepLabel}
        </span>
        <div className="bw-progress-bar" aria-hidden="true">
          <div
            className="bw-progress-fill"
            style={{ width: `${(currentStep / totalSteps) * 100}%` }}
          />
        </div>
        {!rescheduleMode && (
          <span className="bw-progress-time">{estimatedTimeRemaining(state.step)}</span>
        )}
      </div>

      {!rescheduleMode && state.step === 1 && (
        <Step1ServicePicker
          services={services}
          selected={state.selectedService}
          onPick={(service) => {
            dispatch({ type: 'SET_SERVICE', service });
            // For services with a single shared variation that has multiple
            // eligible barbers (or all), Step 2 still lets the user pick.
            // For per-barber-variation services, the eligible set is also
            // multiple. So we always show step 2 — no auto-skip.
          }}
        />
      )}

      {!rescheduleMode && state.step === 2 && state.selectedService && (
        <Step2BarberPicker
          service={state.selectedService}
          barbers={barbers}
          selected={state.selectedBarber}
          anyBarber={state.anyBarber}
          onPickBarber={(barber, variation) => dispatch({ type: 'SET_BARBER', barber, variation })}
          onPickAny={(variation) => dispatch({ type: 'SET_ANY_BARBER', variation })}
          onPickAnyMulti={(variations) => dispatch({ type: 'SET_ANY_BARBER_MULTI', variations })}
        />
      )}

      {state.step === 3 && state.candidateVariations.length > 0 && (
        <Step3DateTimePicker
          variations={state.candidateVariations}
          teamMemberId={teamMemberId}
          selected={state.selectedSlot}
          blockedSlots={state.blockedSlots}
          location={location}
          onPick={(slot: AvailabilitySlot) => {
            // First pick (or single-visit) goes through SET_SLOT,
            // which also auto-advances when desiredCount === 1.
            // Subsequent picks in a multi-visit plan append to
            // pickedSlots and keep the customer on Step 3 so they
            // can keep building.
            if (!state.selectedSlot) {
              dispatch({ type: 'SET_SLOT', slot });
            } else if (state.series.desiredCount > 1) {
              dispatch({ type: 'ADD_PICKED_SLOT', slot });
            } else {
              // Customer changed mind on a single-visit slot —
              // just replace.
              dispatch({ type: 'SET_SLOT', slot });
            }
          }}
          serviceName={state.selectedService?.name ?? 'a haircut'}
          barberName={state.selectedBarber?.displayName ?? 'any barber'}
          prefillName={[state.customer.givenName, state.customer.familyName]
            .filter(Boolean)
            .join(' ')
            .trim()}
          prefillEmail={state.customer.email}
          prefillPhone={state.customer.phone}
          barbers={barbers}
          desiredCount={state.series.desiredCount}
          picks={
            state.selectedSlot
              ? [state.selectedSlot, ...state.series.pickedSlots]
              : []
          }
          pricePerVisitCents={state.selectedVariation?.priceCents ?? null}
          onDesiredCountChange={(desiredCount) =>
            dispatch({ type: 'SET_DESIRED_COUNT', desiredCount })
          }
          onRemovePick={(startAtUtc) =>
            dispatch({ type: 'REMOVE_PICKED_SLOT', startAtUtc })
          }
          onSeriesContinue={() => dispatch({ type: 'GO_TO', step: 4 })}
        />
      )}

      {!rescheduleMode && state.step === 4 && (
        <Step4CustomerInfo
          customer={state.customer}
          onChange={(patch) => dispatch({ type: 'UPDATE_CUSTOMER', patch })}
          onNext={() => dispatch({ type: 'NEXT' })}
        />
      )}

      {showCardCapture && state.cardCapture.customerId && (
        <Step45CardCapture
          customerId={state.cardCapture.customerId}
          cardholderName={`${state.customer.givenName} ${state.customer.familyName}`.trim()}
          customerGivenName={state.customer.givenName}
          customerFamilyName={state.customer.familyName}
          servicePriceDisplay={priceDisplayForBooking(state.selectedService, state.selectedVariation)}
          acknowledgedPolicy={state.cardCapture.acknowledgedPolicy}
          onAcknowledgeChange={(value) =>
            dispatch({ type: 'UPDATE_CARD_CAPTURE', patch: { acknowledgedPolicy: value } })
          }
          onSaved={({ cardId, cardLast4, cardBrand }) =>
            dispatch({
              type: 'UPDATE_CARD_CAPTURE',
              patch: {
                cardId,
                cardLast4: cardLast4 ?? null,
                cardBrand: cardBrand ?? null,
                amountCents:
                  state.cardCapture.amountCents ??
                  priceCentsForBooking(state.selectedService, state.selectedVariation),
              },
            })
          }
          existingCard={null}
        />
      )}

      {state.step === 5 && !showCardCapture && state.selectedService && state.selectedVariation && state.selectedSlot && (
        <Step5Confirm
          service={state.selectedService}
          variation={state.selectedVariation}
          barber={state.selectedBarber}
          anyBarber={state.anyBarber}
          slot={state.selectedSlot}
          customer={state.customer}
          status={state.status}
          onConfirm={submit}
          onEditSlot={() => dispatch({ type: 'GO_TO', step: 3 })}
          onEditCustomer={() => dispatch({ type: 'GO_TO', step: 4 })}
          onBookAnother={() => dispatch({ type: 'START_ANOTHER_BOOKING' })}
          series={state.series}
          rescheduleMode={rescheduleMode}
          onUpdateContactToggle={(value) =>
            dispatch({ type: 'UPDATE_CUSTOMER', patch: { updateContact: value } })
          }
          cardOnFile={
            state.cardCapture.required && state.cardCapture.cardId
              ? {
                  brand: state.cardCapture.cardBrand,
                  last4: state.cardCapture.cardLast4,
                }
              : null
          }
        />
      )}

      {state.step !== 1 && state.status.kind !== 'success' && (
        <div className="bw-nav">
          <button
            type="button"
            className="bw-btn bw-btn--ghost"
            disabled={state.status.kind === 'submitting' || (rescheduleMode && state.step <= 3)}
            onClick={() => {
              // Step 4 (Details) is auto-skipped for both reschedule mode and
              // signed-in customers with complete contact on file. A plain BACK
              // from Step 5 in those cases would land on Step 4 — the skip
              // effect would immediately bounce forward to Step 5 again,
              // trapping the user. Jump straight to Step 3 instead.
              if ((rescheduleMode || skipDetailsStep) && state.step === 5) {
                dispatch({ type: 'GO_TO', step: 3 });
              } else {
                dispatch({ type: 'BACK' });
              }
            }}
          >
            {(rescheduleMode || skipDetailsStep) && state.step === 5
              ? '← Pick a different time'
              : '← Back'}
          </button>
          <span className="bw-nav-spacer" />
          {!rescheduleMode && state.step === 4 && (
            <button
              type="button"
              className="bw-btn"
              disabled={!isStepReachable(state, 5)}
              onClick={() => dispatch({ type: 'NEXT' })}
            >
              Review →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function priceFormat(service: Service, variation: ServiceVariation): string {
  if (variation.priceCents !== null) return `$${(variation.priceCents / 100).toFixed(0)}`;
  if (service.minPriceCents !== null && service.maxPriceCents !== null) {
    return `$${(service.minPriceCents / 100).toFixed(0)}–$${(service.maxPriceCents / 100).toFixed(0)}`;
  }
  return 'Variable';
}

function formatLocalEt(utc: string): string {
  const date = new Date(utc);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function friendlyError(code: string, detail: string): string {
  if (code === 'AUTHENTICATION_ERROR' || code === 'UNAUTHORIZED') {
    return 'Booking system temporarily unavailable. Please call the shop at 740-297-4462.';
  }
  if (code === 'INVALID_TIME' || code === 'BAD_REQUEST') {
    if (/took|taken/i.test(detail)) return 'That slot was just taken. Please pick another.';
    return detail || 'Could not complete your booking. Please try again.';
  }
  if (code === 'NETWORK_ERROR') {
    return "We're not sure if your booking went through. Please check your email or call us at 740-297-4462.";
  }
  if (detail) return `${detail} (${code})`;
  return 'Something went wrong. Please try again.';
}

