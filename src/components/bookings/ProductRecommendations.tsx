import type { Product } from '../../lib/square/products';
import { stripBarberPrefix } from '../../lib/square/products';

interface Props {
  products: Product[];
  intentLabel?: string;
}

const SHOPIFY_BASE = 'https://mdrnclassic.com';

// TODO: replace search-link fallback with direct Shopify product URLs once
// SKU mapping is provided. Square's ecom_uri points at the
// modern-classic.square.site storefront, not the live mdrnclassic.com
// Shopify shop, so we send the user to a Shopify search keyed off the
// product name without the barber prefix.
function shopifyLinkFor(product: Product): string {
  const stripped = stripBarberPrefix(product.name);
  const q = encodeURIComponent(stripped);
  return `${SHOPIFY_BASE}/search?q=${q}`;
}

function priceLabel(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

export function ProductRecommendations({ products, intentLabel }: Props) {
  if (!products || products.length === 0) return null;

  const heading = intentLabel ?? 'Continue your look at home';

  return (
    <section className="mb-recs" aria-labelledby="mb-recs-heading">
      <header className="mb-recs__head">
        <span className="mb-recs__eyebrow">From the Modern Classic shop</span>
        <h2 id="mb-recs-heading">{heading}</h2>
        <p className="mb-recs__copy">
          Hand-picked for your last visit. Same products we use in the chair.
        </p>
      </header>
      <div className="mb-recs__grid">
        {products.map((p) => (
          <a
            key={p.id}
            className="mb-rec"
            href={shopifyLinkFor(p)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {p.imageUrl ? (
              <img
                className="mb-rec__img"
                src={p.imageUrl}
                alt={p.displayName}
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="mb-rec__img" aria-hidden="true" />
            )}
            <h3 className="mb-rec__name">{p.displayName}</h3>
            <span className="mb-rec__price">{priceLabel(p.priceCents)}</span>
            <span className="mb-rec__cta">
              Shop <span aria-hidden="true">→</span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
