import { useEffect, useMemo, useState } from 'react';
import type { AvailabilitySlot, Barber, Service, ServiceVariation } from '../../lib/square/types';
import { formatRelativeSlot } from '../../lib/availability/timing';

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

const AVAIL_WINDOW_DAYS = 365;

export function Step2BarberPicker({
  service,
  barbers,
  selected,
  anyBarber,
  onPickBarber,
  onPickAny,
  onPickAnyMulti,
}: Props) {
  // (barberId, variationId) pairs we need availability for. Memo keyed on
  // service id so picking a different service in step 1 retriggers the
  // fetch. Per-barber-variation services use one (barber, variation) pair
  // per variation; shared-variation services use the single variation
  // against every eligible barber.
  const lookups = useMemo<Array<{ barberId: string; variationId: string }>>(() => {
    if (service.hasPerBarberVariations) {
      const out: Array<{ barberId: string; variationId: string }> = [];
      for (const v of service.variations) {
        const id = v.eligibleTeamMemberIds[0];
        if (id) out.push({ barberId: id, variationId: v.id });
      }
      return out;
    }
    const variation = service.variations[0];
    if (!variation) return [];
    const eligibleIds =
      variation.eligibleTeamMemberIds.length > 0
        ? variation.eligibleTeamMemberIds
        : barbers.map((b) => b.id);
    return eligibleIds.map((barberId) => ({ barberId, variationId: variation.id }));
  }, [service.id, service.hasPerBarberVariations, service.variations, barbers]);

  // Per-barber soonest slot (null = no slot found in window; undefined = still loading).
  const [availMap, setAvailMap] = useState<Record<string, AvailabilitySlot | null | undefined>>({});

  useEffect(() => {
    if (lookups.length === 0) return;
    let cancelled = false;
    // Reset to "loading" for every visible barber when service changes.
    setAvailMap(Object.fromEntries(lookups.map((l) => [l.barberId, undefined])));

    const startAt = new Date();
    const endAt = new Date(Date.now() + AVAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    Promise.all(
      lookups.map(async ({ barberId, variationId }): Promise<[string, AvailabilitySlot | null]> => {
        try {
          const url = new URL('/api/square/availability', window.location.origin);
          url.searchParams.set('serviceVariationId', variationId);
          url.searchParams.set('teamMemberId', barberId);
          url.searchParams.set('startAt', startAt.toISOString());
          url.searchParams.set('endAt', endAt.toISOString());
          const res = await fetch(url.toString());
          if (!res.ok) return [barberId, null];
          const data = (await res.json()) as { ok: boolean; slots?: AvailabilitySlot[] };
          if (!data.ok || !data.slots || data.slots.length === 0) return [barberId, null];
          // searchAvailability returns slots sorted by startAt; take the first.
          return [barberId, data.slots[0]!];
        } catch {
          return [barberId, null];
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setAvailMap(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [lookups]);

  // Soonest slot across all the lookups — for the "Any barber" tile.
  const anySoonest = useMemo<AvailabilitySlot | null | undefined>(() => {
    const values = Object.values(availMap);
    if (values.length === 0) return undefined;
    if (values.some((v) => v === undefined)) return undefined;
    let best: AvailabilitySlot | null = null;
    for (const v of values) {
      if (v && (!best || v.startAtUtc < best.startAtUtc)) best = v;
    }
    return best;
  }, [availMap]);

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
              <NextAvailable slot={anySoonest} />
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
                nextSlot={availMap[barber.id]}
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
            <NextAvailable slot={anySoonest} />
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
              nextSlot={availMap[barber.id]}
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
  nextSlot,
  onClick,
}: {
  barber: Barber;
  priceNote: string;
  active: boolean;
  nextSlot: AvailabilitySlot | null | undefined;
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
        <NextAvailable slot={nextSlot} />
      </span>
    </button>
  );
}

/**
 * Inline 'Next available: {when}' line under each barber card.
 *
 * On Step 2 we deliberately do NOT apply the site-wide 7-day visibility
 * threshold. By the time the user hits this screen they've committed to
 * booking and need to know real lead times so they can pick a barber.
 * Whatever the 14-day search returned is what we show.
 *
 *   slot === undefined  → still loading (renders subtle "Checking…" so the
 *                          card doesn't visibly resize when data arrives)
 *   slot === null       → no slot found in the next 14 days — render nothing
 *   otherwise           → render the slot via formatRelativeSlot, which
 *                          gives "Today X:XX PM" / "Tomorrow X:XX AM" /
 *                          "Friday 10:00 AM" within a week, or
 *                          "Mon, May 12 9:00 AM" for further-out dates.
 */
function NextAvailable({ slot }: { slot: AvailabilitySlot | null | undefined }) {
  if (slot === undefined) {
    return (
      <span className="bw-avail-line bw-avail-line--loading" aria-hidden="true">
        Checking availability…
      </span>
    );
  }
  if (!slot) return null;
  const label = formatRelativeSlot(slot.startAtUtc);
  return (
    <span className="bw-avail-line" aria-label={`Next available: ${label}`}>
      <span className="bw-avail-line__dot" aria-hidden="true" />
      <span className="bw-avail-line__label">Next available:</span>{' '}
      <span className="bw-avail-line__when">{label}</span>
    </span>
  );
}
