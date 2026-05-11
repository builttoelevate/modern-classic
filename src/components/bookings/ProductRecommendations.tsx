// Single-product recommendation card for /my-bookings.
//
// Reads from the same source as /shop (the Astro content collection
// in src/content/products/*.json), so the image, name, and product
// URL match exactly. The picker (lib/recommendations/featuredProduct)
// applies intent matching against the customer's last service to pick
// which featured product to surface here.
//
// Why one card instead of the prior three-up grid: keeps the surface
// tightly scoped to the highest-intent pick. A returning customer
// who just got a haircut sees one Soft Clay card with the same photo
// they'd see on /shop, not three differently-imaged tiles pulled
// from Square's catalog.

import type { FeaturedProduct } from '../../lib/recommendations/featuredProduct';

interface Props {
  product: FeaturedProduct | null;
}

export function ProductRecommendations({ product }: Props) {
  if (!product) return null;

  return (
    <section className="mb-recs" aria-labelledby="mb-recs-heading">
      <header className="mb-recs__head">
        <span className="mb-recs__eyebrow">From the Modern Classic shop</span>
        <h2 id="mb-recs-heading">Continue your look at home</h2>
        <p className="mb-recs__copy">
          Hand-picked for your last visit. Same products we use in the chair.
        </p>
      </header>
      <a
        className="mb-rec mb-rec--solo"
        href={product.productUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <div
          className={
            'mb-rec__img-wrap' +
            (product.whiteBg ? ' mb-rec__img-wrap--white' : '')
          }
        >
          <img
            className="mb-rec__img"
            src={product.imageUrl}
            alt={`${product.name} — ${product.size}`}
            loading="lazy"
            decoding="async"
          />
        </div>
        <div className="mb-rec__body">
          <span className="mb-rec__collection">{product.collection}</span>
          <h3 className="mb-rec__name">{product.name}</h3>
          <p className="mb-rec__size">{product.size}</p>
          <div className="mb-rec__row">
            <span className="mb-rec__price">{product.priceLabel}</span>
            <span className="mb-rec__cta">
              Shop <span aria-hidden="true">→</span>
            </span>
          </div>
        </div>
      </a>
      {/* SVG color-key filter used by mb-rec__img-wrap--white. Same
          matrix as /shop's #mc-key-white so white-seamless studio
          shots render with the white background masked out, matching
          the visual treatment on the shop page. Inline so the
          component is self-contained — only emitted when a product
          actually renders. */}
      {product.whiteBg && (
        <svg
          width="0"
          height="0"
          aria-hidden="true"
          focusable="false"
          style={{ position: 'absolute' }}
        >
          <filter id="mc-key-white" colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  -1 -1 -1 3 0"
            />
            <feComponentTransfer>
              <feFuncA type="table" tableValues="0 0 0 1 1" />
            </feComponentTransfer>
          </filter>
        </svg>
      )}
    </section>
  );
}
