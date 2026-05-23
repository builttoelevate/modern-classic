import type { Service } from '../../lib/square/types';
import { isFirstVisitService } from '../../lib/booking/serviceIntent';
import { NewCustomerGate } from './NewCustomerGate';

interface Props {
  services: Service[];
  selected: Service | null;
  onPick: (service: Service) => void;
  /** When true, every service except the first-visit one renders
   *  disabled. Only set when we've affirmatively detected a new
   *  customer AND a first-visit service exists in the catalog. */
  lockedToFirstVisit: boolean;
  signedIn: boolean;
  isAnonymous: boolean;
  /** Anonymous "Have you visited before?" gate answer. null = haven't
   *  answered yet → gate renders above the grid and the grid hides
   *  until they answer. true/false comes from the gate or sessionStorage. */
  claimedReturning: boolean | null;
  onClaimedReturning: (value: boolean) => void;
  /** False when Square's catalog has no first-visit service. In that
   *  case we fail open — no lock, no gate, just the full menu with a
   *  soft welcome banner for anonymous users. */
  firstVisitServiceAvailable: boolean;
}

// VIC item id from SQUARE_REFERENCE.md §4 — Phase 1 already filters it,
// but per the phase doc we assert it again here as a defensive guard.
const HIDDEN_ITEM_IDS = new Set<string>(['REEU27HVQBIP27KEI47RI73V']);

function priceLabel(service: Service): string {
  const { minPriceCents, maxPriceCents, variations } = service;
  const allVariable = variations.every((v) => v.pricingType === 'VARIABLE_PRICING');
  if (allVariable || minPriceCents === null || maxPriceCents === null) {
    return 'Pricing set in person';
  }
  if (minPriceCents === maxPriceCents) {
    return `$${(minPriceCents / 100).toFixed(0)}`;
  }
  return `$${(minPriceCents / 100).toFixed(0)}–$${(maxPriceCents / 100).toFixed(0)}`;
}

function durationLabel(service: Service): string {
  const durations = Array.from(new Set(service.variations.map((v) => v.durationMinutes)));
  if (durations.length === 1) return `${durations[0]} min`;
  return `${Math.min(...durations)}–${Math.max(...durations)} min`;
}

export function Step1ServicePicker({
  services,
  selected,
  onPick,
  lockedToFirstVisit,
  signedIn,
  isAnonymous,
  claimedReturning,
  onClaimedReturning,
  firstVisitServiceAvailable,
}: Props) {
  const visible = services
    .filter((s) => !HIDDEN_ITEM_IDS.has(s.id))
    .slice()
    .sort((a, b) => {
      const aFirst = isFirstVisitService(a) ? 0 : 1;
      const bFirst = isFirstVisitService(b) ? 0 : 1;
      if (aFirst !== bFirst) return aFirst - bFirst;
      return 0;
    });

  // Anonymous visitor hasn't answered the gate yet — render the gate
  // and hide the grid until they pick. Signed-in / reschedule users
  // never see this (claimedReturning is pinned at wizard mount).
  const showGate = isAnonymous && claimedReturning === null;

  return (
    <div className="bw-step">
      <div className="bw-step-head">
        <h2>Choose a service</h2>
        <p>Pick the cut, trim, or shave you'd like.</p>
      </div>

      {showGate && <NewCustomerGate onAnswer={onClaimedReturning} />}

      {lockedToFirstVisit && !showGate && (
        <div className="bw-newcust-banner" role="note">
          {signedIn ? (
            <>
              <strong>Welcome!</strong> Your first visit is the New Customer service —
              Michael will set pricing and walk you through your options in person.
            </>
          ) : (
            <>
              <strong>First time here?</strong> Start with the New Customer service.{' '}
              <span className="bw-newcust-banner__nudge">
                Already a customer?{' '}
                <a className="link-gold" href="/sign-in?redirect=/book">
                  Sign in
                </a>{' '}
                to see your full menu.
              </span>
            </>
          )}
        </div>
      )}

      {!firstVisitServiceAvailable && isAnonymous && claimedReturning === false && (
        <div className="bw-newcust-banner" role="note">
          <strong>New here?</strong> Welcome — book any service and Michael will get you sorted.
        </div>
      )}

      {!showGate && (
        <div className="bw-grid">
          {visible.map((service) => {
            const active = selected?.id === service.id;
            const isFirstVisit = isFirstVisitService(service);
            const disabled = lockedToFirstVisit && !isFirstVisit;
            return (
              <button
                key={service.id}
                type="button"
                className="bw-card"
                data-selected={active}
                data-locked={disabled ? 'true' : undefined}
                onClick={() => {
                  if (disabled) return;
                  onPick(service);
                }}
                disabled={disabled}
                aria-disabled={disabled || undefined}
                aria-pressed={active}
              >
                <span className="bw-card-name">{service.name}</span>
                <span className="bw-card-price">{priceLabel(service)} · {durationLabel(service)}</span>
                {service.description && (
                  <span className="bw-card-desc">{truncate(service.description, 140)}</span>
                )}
                {disabled && (
                  <span className="bw-card-locked-note" aria-hidden="true">
                    Available after your first visit
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, max - 1).trimEnd() + '…';
}
