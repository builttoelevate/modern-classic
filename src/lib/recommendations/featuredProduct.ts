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
//
// 'haircut+beard' is the combo intent — pools both haircut and
// beard product collections so a combo customer rotates between
// (e.g.) Soft Clay and Beard Oil across visits, instead of always
// seeing a beard product. Rotation is keyed off the seed booking
// ID below so it's stable across refreshes for any given booking
// but varies between bookings.
type Intent = 'beard' | 'shave' | 'haircut' | 'haircut+beard';

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
  // Combo gets its own intent so the picker can rotate between
  // haircut + beard collections instead of always treating the
  // customer as beard-only.
  if (HAIRCUT_BEARD_VARIATIONS.has(variationId)) return 'haircut+beard';
  if (variationId === STRAIGHT_RAZOR_VARIATION) return 'shave';
  return 'haircut';
}

const HAIRCUT_COLLECTIONS: ReadonlySet<string> = new Set([
  'Styling',
  'Texture & Finish',
]);
const BEARD_COLLECTIONS: ReadonlySet<string> = new Set([
  'Beard Care',
  'Shaving / Beard Care',
]);

const INTENT_COLLECTIONS: Record<Exclude<Intent, 'haircut+beard'>, ReadonlySet<string>> = {
  haircut: HAIRCUT_COLLECTIONS,
  beard: BEARD_COLLECTIONS,
  shave: new Set(['Shaving', 'Shaving / Beard Care']),
};

/**
 * Stable per-booking hash for combo rotation. Same bookingId always
 * returns the same boolean — refreshing /my-bookings won't make the
 * pick flip between haircut and beard for a given booking. Different
 * bookings get different picks based on their ID, so a customer who
 * gets combo every 3 weeks sees the recommendation alternate over
 * the year (rather than always seeing the same product).
 *
 * Returns true → prefer haircut collections, false → prefer beard.
 */
function preferHaircutForBooking(bookingId: string | undefined): boolean {
  if (!bookingId) return false; // Fall back to current behavior (beard) when no booking seed.
  // Sum of char codes mod 2 — cheap, deterministic, no crypto needed.
  let sum = 0;
  for (let i = 0; i < bookingId.length; i++) sum = (sum + bookingId.charCodeAt(i)) | 0;
  return (sum & 1) === 0;
}

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
  /** Seed booking ID. Drives the combo-intent rotation so a customer
   *  who always books Haircut & Beard sees a stable-per-booking pick
   *  that alternates between hair and beard collections across
   *  visits instead of always landing on Beard Oil. Ignored for
   *  non-combo intents. */
  seedBookingId?: string;
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

  // Combo: pick the preferred collection set for this booking, fall
  // back to the other set if no featured product matches the
  // preferred. Net effect — customers who always book combo see a
  // stable pick per booking that varies across bookings.
  let targets: ReadonlySet<string>;
  let fallbackTargets: ReadonlySet<string> | null = null;
  if (intent === 'haircut+beard') {
    if (preferHaircutForBooking(input.seedBookingId)) {
      targets = HAIRCUT_COLLECTIONS;
      fallbackTargets = BEARD_COLLECTIONS;
    } else {
      targets = BEARD_COLLECTIONS;
      fallbackTargets = HAIRCUT_COLLECTIONS;
    }
  } else {
    targets = INTENT_COLLECTIONS[intent];
  }

  // Intent-matching featured first, then any featured by order. The
  // sort is already by order so the first hit in either filter is
  // the right one.
  const intentMatch =
    featured.find((p: ProductEntry) => targets.has(p.collection)) ??
    (fallbackTargets
      ? featured.find((p: ProductEntry) => fallbackTargets!.has(p.collection))
      : undefined);
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
