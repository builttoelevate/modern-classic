import { squareFetch } from './client';
import type {
  CatalogItem,
  CatalogItemVariation,
  ListCatalogResponse,
  Service,
  ServiceVariation,
} from './types';

// SQUARE_REFERENCE.md §4 — VIC is currently not bookable; hide it.
const HIDDEN_ITEM_IDS = new Set<string>(['REEU27HVQBIP27KEI47RI73V']);

// SQUARE_REFERENCE.md §3 — Bill Chicha is the dev account. Square attaches
// his id to every bookable variation's `team_member_ids` (presumably so the
// dashboard owner can fill in for any barber), but customers must never
// see him as a bookable option. Strip him at the catalog layer so every
// downstream consumer (eligibility checks, the hasPerBarberVariations
// heuristic, etc.) sees the real barber list.
const HIDDEN_TEAM_MEMBER_IDS = new Set<string>(['TM3BJwsVNRbNXVZp']);

const APPOINTMENTS_PRODUCT_TYPE = 'APPOINTMENTS_SERVICE';

function durationMsToMinutes(ms: number | undefined): number {
  if (!ms || ms <= 0) return 30;
  return Math.round(ms / 60_000);
}

function variationToDerived(v: CatalogItemVariation): ServiceVariation {
  const data = v.item_variation_data;
  const pricingType = data.pricing_type;
  const priceCents =
    pricingType === 'FIXED_PRICING' && typeof data.price_money?.amount === 'number'
      ? data.price_money.amount
      : null;
  const eligibleTeamMemberIds = (data.team_member_ids ?? []).filter(
    (id) => !HIDDEN_TEAM_MEMBER_IDS.has(id),
  );
  return {
    id: v.id,
    name: data.name ?? '',
    priceCents,
    durationMinutes: durationMsToMinutes(data.service_duration),
    version: v.version,
    eligibleTeamMemberIds,
    pricingType,
    availableForBooking: data.available_for_booking ?? true,
  };
}

function itemToService(item: CatalogItem): Service | null {
  if (item.is_deleted) return null;
  const data = item.item_data;
  if (data.product_type !== APPOINTMENTS_PRODUCT_TYPE) return null;
  if (HIDDEN_ITEM_IDS.has(item.id)) return null;

  const variations = (data.variations ?? [])
    .filter((v) => !v.is_deleted)
    .map(variationToDerived)
    .filter((v) => v.availableForBooking);

  if (variations.length === 0) return null;

  const fixedPrices = variations
    .map((v) => v.priceCents)
    .filter((p): p is number => typeof p === 'number');
  const minPrice = fixedPrices.length > 0 ? Math.min(...fixedPrices) : null;
  const maxPrice = fixedPrices.length > 0 ? Math.max(...fixedPrices) : null;

  // A service has per-barber variations when each variation restricts to a
  // different single team member. Heuristic: more than one variation, each
  // with exactly one eligible team member.
  const hasPerBarberVariations =
    variations.length > 1 &&
    variations.every((v) => v.eligibleTeamMemberIds.length === 1);

  return {
    id: item.id,
    name: data.name ?? 'Service',
    description: data.description ?? '',
    variations,
    hasPerBarberVariations,
    minPriceCents: minPrice,
    maxPriceCents: maxPrice,
  };
}

export async function getServices(): Promise<Service[]> {
  const res = await squareFetch<ListCatalogResponse>(
    '/v2/catalog/list',
    { query: { types: 'ITEM,ITEM_VARIATION' } },
  );

  // Square's /v2/catalog/list returns ITEMs with their variations nested
  // when types=ITEM,ITEM_VARIATION. But fall back to manual nesting in case
  // the API returns variations as siblings.
  const objects = res.objects ?? [];
  const items: CatalogItem[] = objects.filter(
    (o): o is CatalogItem => o.type === 'ITEM',
  );
  const variationsByItem = new Map<string, CatalogItemVariation[]>();
  for (const o of objects) {
    if (o.type === 'ITEM_VARIATION') {
      const itemId = o.item_variation_data.item_id;
      const list = variationsByItem.get(itemId) ?? [];
      list.push(o);
      variationsByItem.set(itemId, list);
    }
  }

  for (const item of items) {
    if (!item.item_data.variations || item.item_data.variations.length === 0) {
      item.item_data.variations = variationsByItem.get(item.id) ?? [];
    }
  }

  const services = items
    .map(itemToService)
    .filter((s): s is Service => s !== null);

  // Stable display order — matches the order in SQUARE_REFERENCE.md.
  // Normalize curly quotes to plain ones before matching so 'Men’s' and
  // "Men's" compare equal.
  const normalize = (s: string): string =>
    s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const orderHint = [
    "men's haircut",
    'haircut & beard',
    'beard trim',
    'straight razor',
    'kids',
    'shampoo',
    'haircut + design',
    'new customers',
  ];
  services.sort((a, b) => {
    const an = normalize(a.name);
    const bn = normalize(b.name);
    const ai = orderHint.findIndex((h) => an.includes(h));
    const bi = orderHint.findIndex((h) => bn.includes(h));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return services;
}
