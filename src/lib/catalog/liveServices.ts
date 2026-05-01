// Phase 6 Part D — render-friendly view of the live catalog.
//
// We pull live name/price/duration from Square but keep the marketing
// copy (description, audience tagline, ordering, category bucket) in
// the existing content collection. Each Square service is matched to
// a content entry by a stable signature of variation IDs.

import { cached } from '../availability/cache';
import { getServices } from '../square/catalog';
import type { Service } from '../square/types';

/**
 * Cached version of getServices() — catalog rarely changes, but homepage
 * SSR shouldn't hit Square on every request. 30-minute TTL is well under
 * the 24-hour cron rebuild cycle so price edits still propagate.
 */
export async function getServicesCached(): Promise<Service[]> {
  return cached('catalog:services', 30 * 60, () => getServices());
}

export interface LiveServiceCard {
  /** Slug for grouping — matches the existing content-collection slug. */
  slug: string;
  /** Human-friendly service name (live from Square). */
  name: string;
  /** Display price like "$30", "$30–45", or "Set in person". */
  priceLabel: string;
  /** Display duration like "30 min", "1 hr". */
  durationLabel: string;
  /** Marketing tagline (audience), kept hand-written. May be null. */
  audience: string | null;
  /** Marketing description, kept hand-written. */
  description: string;
  /** Category bucket the existing /services page uses. */
  group: 'haircuts' | 'beard' | 'shave' | 'style';
  /** Display order — lower = earlier. */
  order: number;
  /**
   * First bookable variation ID. Used to pre-select this service in the
   * /book wizard via `?service=<id>` so callers (homepage service tiles,
   * /services page rows) can deep-link directly to Step 2 (Choose your
   * barber). Null if the service has no bookable variations — caller
   * should fall back to a generic /book link in that case.
   */
  primaryVariationId: string | null;
}

/** Description + audience copy keyed by slug. Editable without touching code. */
interface MarketingCopy {
  slug: string;
  audience: string | null;
  description: string;
  group: LiveServiceCard['group'];
  order: number;
}

const COPY: MarketingCopy[] = [
  {
    slug: 'mens-haircut',
    audience: '11 & older',
    description:
      "A clean, detailed haircut for men and young men. Tailored to your style and finished sharp.",
    group: 'haircuts',
    order: 1,
  },
  {
    slug: 'haircut-beard',
    audience: 'Modern or Classic',
    description:
      'A complete grooming service. You walk out with your beard tame, your edges crisp, and your style on point.',
    group: 'beard',
    order: 2,
  },
  {
    slug: 'beard-trim-edge',
    audience: 'Sharp edges',
    description:
      'A clean shape-up for shorter beards or weekly maintenance — line, edge, and detail.',
    group: 'beard',
    order: 3,
  },
  {
    slug: 'kids-haircut',
    audience: '10 & under',
    description:
      "A patient, clean cut for younger clients in a calm, family-friendly chair.",
    group: 'haircuts',
    order: 4,
  },
  {
    slug: 'haircut-design',
    audience: 'Freestyle hair art',
    description:
      'More time, more detail. Includes special haircut add-ons like freestyle designs and hair art.',
    group: 'haircuts',
    order: 5,
  },
  {
    slug: 'straight-razor-shave',
    audience: 'Hot towels & a single blade',
    description:
      'Traditional straight razor shave with hot towels, rich lather, and a finishing balm.',
    group: 'shave',
    order: 6,
  },
  {
    slug: 'new-customer',
    audience: null,
    description:
      'Recommended for new clients or anyone unsure what style they want. Includes extra consultation time.',
    group: 'haircuts',
    order: 7,
  },
  {
    slug: 'shampoo-style',
    audience: 'In-and-out finishing',
    description:
      "A quick wash and style — perfect between cuts when you want to walk out fresh.",
    group: 'style',
    order: 8,
  },
];

/**
 * Map a live Square service to a known marketing slug. Uses normalized
 * service name. Anything we don't recognize falls into the "style" group
 * with a default order so it still renders.
 */
function slugForService(service: Service): MarketingCopy {
  const norm = service.name.toLowerCase().replace(/[‘’]/g, "'").trim();
  if (norm.includes("men's haircut")) return COPY.find((c) => c.slug === 'mens-haircut')!;
  if (norm.includes('haircut & beard')) return COPY.find((c) => c.slug === 'haircut-beard')!;
  if (norm.includes('beard trim')) return COPY.find((c) => c.slug === 'beard-trim-edge')!;
  if (norm.includes('kids')) return COPY.find((c) => c.slug === 'kids-haircut')!;
  if (norm.includes('haircut + design') || norm.includes('haircut design')) {
    return COPY.find((c) => c.slug === 'haircut-design')!;
  }
  if (norm.includes('straight razor') || norm.includes('shave')) {
    return COPY.find((c) => c.slug === 'straight-razor-shave')!;
  }
  if (norm.includes('new customer')) return COPY.find((c) => c.slug === 'new-customer')!;
  if (norm.includes('shampoo')) return COPY.find((c) => c.slug === 'shampoo-style')!;
  // Fallback — unknown service, drop into Style with a high order so it
  // sorts last.
  return {
    slug: norm.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'service',
    audience: null,
    description: service.description || '',
    group: 'style',
    order: 100,
  };
}

function priceLabelFor(service: Service): string {
  const fixedPrices = service.variations
    .filter((v) => v.priceCents !== null)
    .map((v) => v.priceCents as number);
  if (fixedPrices.length > 0) {
    const min = Math.min(...fixedPrices);
    const max = Math.max(...fixedPrices);
    if (min === max) return `$${(min / 100).toFixed(0)}`;
    return `$${(min / 100).toFixed(0)}–$${(max / 100).toFixed(0)}`;
  }
  // Variable price — display "Starting at $30" using the description-fallback.
  // Square stores the variable-price ranges in the item description; we
  // can't infer them reliably so keep a friendly default.
  return 'Starting at $30';
}

function durationLabelFor(service: Service): string {
  const durations = Array.from(new Set(service.variations.map((v) => v.durationMinutes)));
  if (durations.length === 0) return '30 min';
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const fmt = (m: number) => (m % 60 === 0 ? `${m / 60} hr` : `${m} min`);
  if (min === max) return fmt(min);
  return `${fmt(min)}–${fmt(max)}`;
}

export function toLiveServiceCards(services: Service[]): LiveServiceCard[] {
  const cards: LiveServiceCard[] = [];
  for (const service of services) {
    const copy = slugForService(service);
    // Prefer a bookable variation, fall back to first variation, fall
    // back to null (service has no variations at all — should be
    // unreachable but keeps types honest).
    const primaryVariation =
      service.variations.find((v) => v.availableForBooking) ??
      service.variations[0] ??
      null;
    cards.push({
      slug: copy.slug,
      name: service.name,
      priceLabel: priceLabelFor(service),
      durationLabel: durationLabelFor(service),
      audience: copy.audience,
      description: copy.description,
      group: copy.group,
      order: copy.order,
      primaryVariationId: primaryVariation?.id ?? null,
    });
  }
  cards.sort((a, b) => a.order - b.order);
  return cards;
}
