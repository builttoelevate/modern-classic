// Picks one featured product for the /my-bookings recommendations
// surface. Reads from the same Astro content collection that powers
// /shop — products in src/content/products/*.json — so the image,
// name, and product URL on the booking page match the shop exactly.
//
// Selection logic:
//   1. Derive an intent from the customer's seed booking (last
//      service-variation they had). Intent → collection mapping:
//        haircut → "Styling" or "Texture & Finish"
//        beard   → "Beard Care" or "Shaving / Beard Care"
//        shave   → "Shaving" or "Shaving / Beard Care"
//   2. Among products tagged `featured: true`, pick the one with the
//      lowest `order` that matches the intent's collections.
//   3. If nothing matches, fall back to the lowest-order featured
//      product (always a sensible pick — these are the curated
//      flagships that drive the shop).

import { getCollection } from 'astro:content';

// Local mirror of the products content-collection schema (see
// src/content/config.ts). Duplicated here so this .ts file
// type-checks cleanly without leaning on astro:content's generated
// types, which tsc --noEmit can't resolve outside the Astro build.
interface ProductEntry {
  name: string;
  slug: string;
  collection: string;
  size: string;
  price: number;
  description: string;
  howToUse: string | null;
  ingredients: string;
  imageUrl: string;
  productUrl: string;
  featured: boolean;
  order: number;
  whiteBg?: boolean;
}

export interface FeaturedProduct {
  name: string;
  /** Pre-formatted price like "$25" for direct render. */
  priceLabel: string;
  size: string;
  imageUrl: string;
  /** Live mdrnclassic.com product page URL. */
  productUrl: string;
  /** Short collection label ("Styling", "Beard Care", etc.) used as
   *  the eyebrow tag above the name. */
  collection: string;
  /** True when imageUrl is a white-seamless studio shot. The card
   *  applies a vignette to mask the white edges so the bottle reads
   *  against the dark card background — mirrors the /shop treatment. */
  whiteBg: boolean;
}

// Same intent vocabulary as recommendForBooking. Kept local so the
// content-collection picker doesn't depend on the Square-products
// module (which is on its way out for the recs surface).
type Intent = 'beard' | 'shave' | 'haircut';

// Square variation ids → intent. Mirror of the table in
// recommendForBooking.ts; duplicated here to keep this module
// standalone.
const BEARD_TRIM_VARIATION = '3QMIIG6HB5G47PHKQALEAJAI';
const STRAIGHT_RAZOR_VARIATION = 'TPW66NFYZQCM53WYEMXKMZ5P';
const HAIRCUT_BEARD_VARIATIONS = new Set<string>([
  'N4IJA4NS7UAGUCVKB2W7CNT6', // Michael
  '4G4VGRJLFZ6GRPHHZX4SNREA', // Clayton
  'ISWN4J5VU6HH6CDPX5IEWG4K', // Rick
]);

function intentForVariation(variationId: string | undefined): Intent {
  if (!variationId) return 'haircut';
  if (variationId === BEARD_TRIM_VARIATION) return 'beard';
  if (HAIRCUT_BEARD_VARIATIONS.has(variationId)) return 'beard';
  if (variationId === STRAIGHT_RAZOR_VARIATION) return 'shave';
  return 'haircut';
}

const INTENT_COLLECTIONS: Record<Intent, ReadonlySet<string>> = {
  haircut: new Set(['Styling', 'Texture & Finish']),
  beard: new Set(['Beard Care', 'Shaving / Beard Care']),
  shave: new Set(['Shaving', 'Shaving / Beard Care']),
};

function priceLabel(p: number): string {
  // Whole-dollar prices render as "$25"; fractional prices keep one
  // decimal (e.g. "$19.97") so we don't lie about the cents.
  return Number.isInteger(p) ? `$${p}` : `$${p.toFixed(2)}`;
}

export interface PickInput {
  /** Last service variation the customer had, used to derive intent.
   *  Undefined when the customer has no bookings on file — picker
   *  falls back to the top-order featured product. */
  seedServiceVariationId?: string;
}

export async function pickFeaturedProduct(
  input: PickInput = {},
): Promise<FeaturedProduct | null> {
  const collection = await getCollection('products');
  const all: ProductEntry[] = collection.map(
    (p: { data: ProductEntry }) => p.data,
  );
  const featured = all
    .filter((p: ProductEntry) => p.featured)
    .sort((a: ProductEntry, b: ProductEntry) => a.order - b.order);
  if (featured.length === 0) return null;

  const intent = intentForVariation(input.seedServiceVariationId);
  const targets = INTENT_COLLECTIONS[intent];

  // Intent-matching featured first, then any featured by order. The
  // sort is already by order so the first hit in either filter is
  // the right one.
  const intentMatch = featured.find((p: ProductEntry) => targets.has(p.collection));
  const pick = intentMatch ?? featured[0];

  return {
    name: pick.name,
    priceLabel: priceLabel(pick.price),
    size: pick.size,
    imageUrl: pick.imageUrl,
    productUrl: pick.productUrl,
    collection: pick.collection,
    whiteBg: pick.whiteBg === true,
  };
}
