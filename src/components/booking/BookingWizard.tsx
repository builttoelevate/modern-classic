import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Barber, Location, Service, ServiceVariation, AvailabilitySlot } from '../../lib/square/types';
import { Step1ServicePicker } from './Step1ServicePicker';
import { Step2BarberPicker } from './Step2BarberPicker';
import { Step3DateTimePicker } from './Step3DateTimePicker';
import { Step4CustomerInfo } from './Step4CustomerInfo';
import { Step5Confirm } from './Step5Confirm';
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
          note: state.customer.note.trim() || undefined,
          updateContact: overrideCustomerId ? false : state.customer.updateContact,
          marketingConsent: overrideCustomerId ? false : state.customer.marketingConsent,
        },
        existingCustomerId: overrideCustomerId,
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

  const reset = () => {
    if (rescheduleMode) {
      // In reschedule mode "Book another" doesn't apply — send the user
      // back to their bookings page. The success screen also offers a
      // direct link, but we honor the existing onBookAnother callback.
      window.location.href = '/my-bookings';
      return;
    }
    dispatch({ type: 'RESET' });
  };

  const teamMemberId = state.anyBarber ? undefined : state.selectedBarber?.id;

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
  const totalSteps = rescheduleMode ? 2 : skipDetailsStep ? 4 : 5;
  const currentStep = rescheduleMode
    ? rescheduleStepIndex
    : skipDetailsStep
      ? skippedStepIndex
      : state.step;
  const stepLabel = rescheduleMode
    ? RESCHEDULE_STEP_LABELS[rescheduleStepIndex - 1]
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
          onPick={(slot: AvailabilitySlot) => dispatch({ type: 'SET_SLOT', slot })}
          serviceName={state.selectedService?.name ?? 'a haircut'}
          barberName={state.selectedBarber?.displayName ?? 'any barber'}
          prefillName={[state.customer.givenName, state.customer.familyName]
            .filter(Boolean)
            .join(' ')
            .trim()}
          prefillEmail={state.customer.email}
          prefillPhone={state.customer.phone}
        />
      )}

      {!rescheduleMode && state.step === 4 && (
        <Step4CustomerInfo
          customer={state.customer}
          onChange={(patch) => dispatch({ type: 'UPDATE_CUSTOMER', patch })}
          onNext={() => dispatch({ type: 'NEXT' })}
        />
      )}

      {state.step === 5 && state.selectedService && state.selectedVariation && state.selectedSlot && (
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
          onBookAnother={reset}
          rescheduleMode={rescheduleMode}
          onUpdateContactToggle={(value) =>
            dispatch({ type: 'UPDATE_CUSTOMER', patch: { updateContact: value } })
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
              if (rescheduleMode && state.step === 5) {
                dispatch({ type: 'GO_TO', step: 3 });
              } else {
                dispatch({ type: 'BACK' });
              }
            }}
          >
            {rescheduleMode && state.step === 5 ? '← Pick a different time' : '← Back'}
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

