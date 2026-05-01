// Phase 5 Part D — recommend products from the customer's most recent
// (or upcoming) booking. Logic: blend service intent with the booking's
// barber.

import type { AssociatedBarberCode, Product } from '../square/products';

// SQUARE_REFERENCE.md §3 — barber team-member ids → product code.
const BARBER_ID_TO_CODE: Record<string, AssociatedBarberCode> = {
  '523GMGEC1FY0Z': 'MICHAEL',
  TMZ4GRNFpRhnzLbv: 'RICK',
  TMwUNkXCCC_i3vyZ: 'CLAYTON',
};

// SQUARE_REFERENCE.md §4 — variation IDs we treat as service "intents".
const BEARD_TRIM_VARIATION = '3QMIIG6HB5G47PHKQALEAJAI';
const SHAMPOO_STYLE_VARIATION = 'CLAOC767V22KP4NERKQZ7QE2';
const STRAIGHT_RAZOR_VARIATION = 'TPW66NFYZQCM53WYEMXKMZ5P';

const HAIRCUT_BEARD_VARIATIONS = new Set<string>([
  'N4IJA4NS7UAGUCVKB2W7CNT6', // Michael
  '4G4VGRJLFZ6GRPHHZX4SNREA', // Clayton
  'ISWN4J5VU6HH6CDPX5IEWG4K', // Rick
]);

type Intent = 'beard' | 'shampoo' | 'shave' | 'haircut';

const INTENT_KEYWORDS: Record<Intent, string[]> = {
  beard: ['BEARD', 'OIL', 'BUTTER', 'BALM'],
  shampoo: ['SHAMPOO', 'CONDITIONER', 'STYL CREAM', 'STYLING CREAM'],
  shave: ['AFTERSHAVE', 'SHAVE CREAM', 'SHAVE BALM'],
  haircut: ['POMADE', 'CLAY', 'MATTE PASTE', 'POWDER', 'TEXTURE'],
};

export interface RecommendInput {
  barberId?: string;
  serviceVariationId?: string;
  allProducts: Product[];
}

function intentForVariation(variationId: string | undefined): Intent {
  if (!variationId) return 'haircut';
  if (variationId === BEARD_TRIM_VARIATION) return 'beard';
  if (HAIRCUT_BEARD_VARIATIONS.has(variationId)) return 'beard';
  if (variationId === SHAMPOO_STYLE_VARIATION) return 'shampoo';
  if (variationId === STRAIGHT_RAZOR_VARIATION) return 'shave';
  return 'haircut';
}

function matchesIntent(product: Product, intent: Intent): boolean {
  const upper = product.name.toUpperCase();
  return INTENT_KEYWORDS[intent].some((kw) => upper.includes(kw));
}

function dedupe(list: Product[]): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of list) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function recommendForBooking({
  barberId,
  serviceVariationId,
  allProducts,
}: RecommendInput): Product[] {
  if (allProducts.length === 0) return [];

  const intent = intentForVariation(serviceVariationId);
  const barberCode = barberId ? BARBER_ID_TO_CODE[barberId] ?? null : null;

  const sameBarberMatching: Product[] = [];
  const sameBarberOther: Product[] = [];
  const otherBarberMatching: Product[] = [];
  const otherBarberOther: Product[] = [];

  for (const p of allProducts) {
    const sameBarber = barberCode !== null && p.associatedBarberCode === barberCode;
    const noBarberFilter = barberCode === null;
    const matches = matchesIntent(p, intent);
    if (sameBarber || noBarberFilter) {
      if (matches) sameBarberMatching.push(p);
      else sameBarberOther.push(p);
    } else {
      if (matches) otherBarberMatching.push(p);
      else otherBarberOther.push(p);
    }
  }

  const picked = dedupe([
    ...sameBarberMatching,
    ...sameBarberOther,
    ...otherBarberMatching,
    ...otherBarberOther,
  ]);

  return picked.slice(0, 3);
}

/**
 * Generic fallback when the customer has no bookings yet — show 3
 * visible products (any barber). Backbar items are already filtered
 * out by getRetailProducts.
 */
export function generalRecommendations(allProducts: Product[]): Product[] {
  return allProducts.slice(0, 3);
}
