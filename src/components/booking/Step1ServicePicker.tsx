import type { Service } from '../../lib/square/types';

interface Props {
  services: Service[];
  selected: Service | null;
  onPick: (service: Service) => void;
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

export function Step1ServicePicker({ services, selected, onPick }: Props) {
  const visible = services.filter((s) => !HIDDEN_ITEM_IDS.has(s.id));

  return (
    <div className="bw-step">
      <div className="bw-step-head">
        <h2>Choose a service</h2>
        <p>Pick the cut, trim, or shave you'd like.</p>
      </div>
      <div className="bw-grid">
        {visible.map((service) => {
          const active = selected?.id === service.id;
          return (
            <button
              key={service.id}
              type="button"
              className="bw-card"
              data-selected={active}
              onClick={() => onPick(service)}
              aria-pressed={active}
            >
              <span className="bw-card-name">{service.name}</span>
              <span className="bw-card-price">{priceLabel(service)} · {durationLabel(service)}</span>
              {service.description && (
                <span className="bw-card-desc">{truncate(service.description, 140)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, max - 1).trimEnd() + '…';
}
