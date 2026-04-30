import { useEffect, useReducer, useRef, useState } from 'react';
import type { Barber, Location, Service, ServiceVariation, AvailabilitySlot } from '../../lib/square/types';
import { Step1ServicePicker } from './Step1ServicePicker';
import { Step2BarberPicker } from './Step2BarberPicker';
import { Step3DateTimePicker } from './Step3DateTimePicker';
import { Step4CustomerInfo } from './Step4CustomerInfo';
import { Step5Confirm } from './Step5Confirm';
import {
  initialState,
  reducer,
  isStepReachable,
  digits,
  type WizardState,
  type WizardStep,
} from './wizardState';
import type { CreateBookingResponse } from '../../lib/booking/types';

interface Props {
  services: Service[];
  barbers: Barber[];
  location: Location | null;
}

const STORAGE_KEY = 'mc:booking-wizard:v1';
const STEP_LABELS = ['Service', 'Barber', 'Time', 'Details', 'Confirm'];

function loadPersisted(): WizardState | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WizardState>;
    // Only restore the data, never a stale status (e.g. submitting).
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...initialState,
      ...parsed,
      status: { kind: 'idle' },
    };
  } catch {
    return null;
  }
}

function persist(state: WizardState): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const { status: _ignore, ...rest } = state;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    /* ignore quota errors */
  }
}

function clearPersisted(): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

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

export default function BookingWizard({ services, barbers, location }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [toast, setToast] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  // One-time hydration from sessionStorage. We do this in an effect (not as
  // an initial reducer arg) so SSR markup matches what hydrates.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const persisted = loadPersisted();
    if (persisted && isStateRehydratable(persisted, services, barbers)) {
      dispatch({ type: 'HYDRATE', state: persisted });
    }
  }, [services, barbers]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    persist(state);
  }, [state]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

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

  const submit = async () => {
    if (!state.selectedService || !state.selectedVariation || !state.selectedSlot) return;
    const teamMemberId = state.anyBarber
      ? state.selectedSlot.teamMemberId
      : state.selectedBarber?.id;
    if (!teamMemberId) return;

    dispatch({ type: 'STATUS', status: { kind: 'submitting' } });

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
        givenName: state.customer.givenName.trim(),
        familyName: state.customer.familyName.trim(),
        email: state.customer.email.trim(),
        phone: digits(state.customer.phone),
        note: state.customer.note.trim() || undefined,
        updateContact: state.customer.updateContact,
      },
    };

    let body: CreateBookingResponse;
    let networkError = false;
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
      clearPersisted();
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
    clearPersisted();
    dispatch({ type: 'RESET' });
  };

  const teamMemberId = state.anyBarber ? undefined : state.selectedBarber?.id;

  return (
    <div className="bw">
      {toast && (
        <div className="bw-toast" role="status">
          {toast}
        </div>
      )}

      <div className="bw-head">
        <h1>Book your appointment</h1>
        <p>Five quick steps. Real-time availability from Square.</p>
      </div>

      <div className="bw-progress" aria-label={`Step ${state.step} of 5`}>
        <span className="bw-progress-label">
          Step {state.step} of 5 · {STEP_LABELS[state.step - 1]}
        </span>
        <div className="bw-progress-bar" aria-hidden="true">
          <div className="bw-progress-fill" style={{ width: `${(state.step / 5) * 100}%` }} />
        </div>
        <span className="bw-progress-time">{estimatedTimeRemaining(state.step)}</span>
      </div>

      {state.step === 1 && (
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

      {state.step === 2 && state.selectedService && (
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
        />
      )}

      {state.step === 4 && (
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
            disabled={state.status.kind === 'submitting'}
            onClick={() => dispatch({ type: 'BACK' })}
          >
            ← Back
          </button>
          <span className="bw-nav-spacer" />
          {state.step === 4 && (
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

function isStateRehydratable(
  state: WizardState,
  services: Service[],
  barbers: Barber[],
): boolean {
  if (state.selectedService) {
    const match = services.find((s) => s.id === state.selectedService!.id);
    if (!match) return false;
  }
  if (state.selectedBarber) {
    const match = barbers.find((b) => b.id === state.selectedBarber!.id);
    if (!match) return false;
  }
  return true;
}
