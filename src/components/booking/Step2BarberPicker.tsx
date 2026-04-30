import type { Barber, Service, ServiceVariation } from '../../lib/square/types';

interface Props {
  service: Service;
  barbers: Barber[];
  selected: Barber | null;
  anyBarber: boolean;
  onPickBarber: (barber: Barber, variation: ServiceVariation) => void;
  onPickAny: (variation: ServiceVariation) => void;
  /** Used when picking "Any" on a per-barber service — searches all variations. */
  onPickAnyMulti: (variations: ServiceVariation[]) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]!.toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Step2BarberPicker({
  service,
  barbers,
  selected,
  anyBarber,
  onPickBarber,
  onPickAny,
  onPickAnyMulti,
}: Props) {
  // Per-barber variation services: each variation has exactly one team
  // member id. Picking a barber resolves which variation to use.
  if (service.hasPerBarberVariations) {
    const pairs: Array<{ barber: Barber; variation: ServiceVariation }> = [];
    for (const v of service.variations) {
      const memberId = v.eligibleTeamMemberIds[0];
      const barber = barbers.find((b) => b.id === memberId);
      if (barber) pairs.push({ barber, variation: v });
    }
    // Price summary for the "Any" tile. All per-barber variations are the
    // same price for the services we have today ($30 / $45), so show the
    // shared price; if Square ever publishes per-barber pricing we fall
    // back to a range.
    const prices = pairs
      .map(({ variation }) => variation.priceCents)
      .filter((p): p is number => typeof p === 'number');
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;
    const priceNote =
      min === null || max === null
        ? 'Variable pricing'
        : min === max
          ? `$${(min / 100).toFixed(0)}`
          : `$${(min / 100).toFixed(0)}–$${(max / 100).toFixed(0)}`;

    return (
      <div className="bw-step">
        <Heading service={service} />
        <div className="bw-grid bw-grid--3">
          <button
            type="button"
            className="bw-card bw-barber-card"
            data-selected={anyBarber}
            aria-pressed={anyBarber}
            onClick={() => onPickAnyMulti(pairs.map((p) => p.variation))}
          >
            <span className="bw-barber-photo" aria-hidden="true">★</span>
            <span className="bw-barber-text">
              <span className="bw-card-name">Any barber</span>
              <span className="bw-card-meta">First available · {priceNote}</span>
            </span>
          </button>
          {pairs.map(({ barber, variation }) => {
            const active = !anyBarber && selected?.id === barber.id;
            return (
              <BarberCard
                key={barber.id}
                barber={barber}
                priceNote={variation.priceCents !== null ? `$${(variation.priceCents / 100).toFixed(0)} · ${variation.durationMinutes} min` : 'Variable pricing'}
                active={active}
                onClick={() => onPickBarber(barber, variation)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // Shared-variation services: one variation, multiple eligible team
  // members (or all). Show every eligible barber + an "any" option.
  const variation = service.variations[0]!;
  const eligibleIds = variation.eligibleTeamMemberIds.length > 0
    ? new Set(variation.eligibleTeamMemberIds)
    : new Set(barbers.map((b) => b.id));
  const eligible = barbers.filter((b) => eligibleIds.has(b.id));

  return (
    <div className="bw-step">
      <Heading service={service} />
      <div className="bw-grid bw-grid--3">
        <button
          type="button"
          className="bw-card bw-barber-card"
          data-selected={anyBarber}
          aria-pressed={anyBarber}
          onClick={() => onPickAny(variation)}
        >
          <span className="bw-barber-photo" aria-hidden="true">★</span>
          <span className="bw-barber-text">
            <span className="bw-card-name">Any barber</span>
            <span className="bw-card-meta">First available</span>
          </span>
        </button>
        {eligible.map((barber) => {
          const active = !anyBarber && selected?.id === barber.id;
          return (
            <BarberCard
              key={barber.id}
              barber={barber}
              priceNote={variation.priceCents !== null ? `$${(variation.priceCents / 100).toFixed(0)} · ${variation.durationMinutes} min` : 'Variable pricing'}
              active={active}
              onClick={() => onPickBarber(barber, variation)}
            />
          );
        })}
      </div>
    </div>
  );
}

function Heading({ service }: { service: Service }) {
  return (
    <div className="bw-step-head">
      <h2>Choose your barber</h2>
      <p>Booking <strong>{service.name}</strong>. {service.hasPerBarberVariations
        ? 'Pick whichever barber you\'d like.'
        : 'Pick a specific barber, or take the first available.'}</p>
    </div>
  );
}

function BarberCard({
  barber,
  priceNote,
  active,
  onClick,
}: {
  barber: Barber;
  priceNote: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="bw-card bw-barber-card"
      data-selected={active}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="bw-barber-photo" aria-hidden="true">{initials(barber.displayName)}</span>
      <span className="bw-barber-text">
        <span className="bw-card-name">{barber.displayName}</span>
        <span className="bw-card-meta">{barber.role} · {priceNote}</span>
      </span>
    </button>
  );
}
