// Phase 5 Part D — retail products from the Square catalog.
//
// We reuse /v2/catalog/list (already cached / similar to getServices) but
// filter to product_type === "REGULAR". Modern Classic encodes the
// associated barber in the product name prefix ("MIC-", "RICK-",
// "CLAYTON-", "BACKBAR-"). Backbar items are internal supplies — exclude.

import { squareFetch } from './client';
import type { ListCatalogResponse, SquareMoney } from './types';

export type AssociatedBarberCode = 'MICHAEL' | 'RICK' | 'CLAYTON' | null;

export interface Product {
  id: string;
  name: string;
  /** Display name with the barber prefix stripped, suitable for cards. */
  displayName: string;
  priceCents: number;
  ecomUri?: string;
  imageUrl?: string;
  categories: string[];
  associatedBarberCode: AssociatedBarberCode;
  isArchived: boolean;
}

interface CatalogItemDataExtended {
  name?: string;
  description?: string;
  product_type?: string;
  is_archived?: boolean;
  ecom_visibility?: string;
  ecom_uri?: string;
  ecom_image_uris?: string[];
  categories?: Array<{ id?: string; name?: string }>;
  variations?: Array<{
    type: 'ITEM_VARIATION';
    id: string;
    is_deleted?: boolean;
    item_variation_data?: {
      pricing_type?: string;
      price_money?: SquareMoney;
      sku?: string;
      name?: string;
    };
  }>;
}

interface CatalogItemRetail {
  type: 'ITEM';
  id: string;
  is_deleted?: boolean;
  item_data?: CatalogItemDataExtended;
}

interface RetailListResponse {
  objects?: Array<CatalogItemRetail | { type: string; id: string }>;
}

const REGULAR_PRODUCT_TYPE = 'REGULAR';

function parseAssociatedBarber(name: string): {
  code: AssociatedBarberCode;
  exclude: boolean;
} {
  const upper = name.trim().toUpperCase();
  if (upper.startsWith('BACKBAR-') || upper.startsWith('BACKBAR ')) {
    return { code: null, exclude: true };
  }
  if (upper.startsWith('MIC-') || upper.startsWith('MIC ')) {
    return { code: 'MICHAEL', exclude: false };
  }
  if (upper.startsWith('RICK-') || upper.startsWith('RICK ')) {
    return { code: 'RICK', exclude: false };
  }
  if (upper.startsWith('CLAYTON-') || upper.startsWith('CLAYTON ')) {
    return { code: 'CLAYTON', exclude: false };
  }
  return { code: null, exclude: false };
}

export function stripBarberPrefix(name: string): string {
  return name.replace(/^(MIC|RICK|CLAYTON|BACKBAR)[-\s]+/i, '').trim();
}

export function displayNameWithLine(name: string, code: AssociatedBarberCode): string {
  const stripped = stripBarberPrefix(name);
  const titled = toTitleCase(stripped);
  if (!code) return titled;
  const barber = code === 'MICHAEL' ? 'Michael' : code === 'RICK' ? 'Rick' : 'Clayton';
  return `${titled} — ${barber}'s Line`;
}

function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/(\s+|-|—)/)
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

function smallestPriceCents(item: CatalogItemRetail): number {
  const variations = item.item_data?.variations ?? [];
  let best: number | null = null;
  for (const v of variations) {
    if (v.is_deleted) continue;
    const data = v.item_variation_data;
    if (!data) continue;
    if (data.pricing_type !== 'FIXED_PRICING') continue;
    const amount = data.price_money?.amount;
    if (typeof amount === 'number' && amount > 0) {
      if (best === null || amount < best) best = amount;
    }
  }
  return best ?? 0;
}

function toProduct(item: CatalogItemRetail): Product | null {
  if (item.is_deleted) return null;
  const data = item.item_data;
  if (!data) return null;
  if (data.product_type !== REGULAR_PRODUCT_TYPE) return null;
  if (data.is_archived) return null;
  if (data.ecom_visibility === 'UNAVAILABLE' || data.ecom_visibility === 'UNINDEXED') return null;
  const name = data.name?.trim();
  if (!name) return null;
  const { code, exclude } = parseAssociatedBarber(name);
  if (exclude) return null;
  const priceCents = smallestPriceCents(item);
  if (priceCents === 0) return null;

  const categories = (data.categories ?? [])
    .map((c) => c.name?.trim() ?? '')
    .filter((s) => s.length > 0);

  return {
    id: item.id,
    name,
    displayName: displayNameWithLine(name, code),
    priceCents,
    ecomUri: data.ecom_uri,
    imageUrl: data.ecom_image_uris?.[0],
    categories,
    associatedBarberCode: code,
    isArchived: false,
  };
}

export async function getRetailProducts(): Promise<Product[]> {
  const res = (await squareFetch<ListCatalogResponse>('/v2/catalog/list', {
    query: { types: 'ITEM,ITEM_VARIATION' },
  })) as unknown as RetailListResponse;

  const objects = res.objects ?? [];
  const items = objects.filter(
    (o): o is CatalogItemRetail => o.type === 'ITEM',
  );
  const products: Product[] = [];
  for (const item of items) {
    const p = toProduct(item);
    if (p) products.push(p);
  }
  return products;
}
