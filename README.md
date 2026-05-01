# Modern Classic

Astro website for **Modern Classic Barbershop & Shave Parlor** (and the
**MDRN Classic Grooming Essentials** product line) — a single Zanesville,
Ohio business currently split across Square (bookings) and Shopify
(e-commerce). This site at `mdrnclassic.com` is the unified front door:
marketing, brand, services, and product showcase rendered natively for
SEO and brand cohesion. Bookings deep-link to Square; product checkout
deep-links to Shopify.

Brand thesis: **Get the cut. Keep the style.**

---

## Stack

- **Astro 5** — `output: 'static'`, ships as plain HTML/CSS/WebP. No
  framework UI runtime.
- **Plain CSS** with custom properties (`src/styles/tokens.css`,
  `src/styles/global.css`). No Tailwind, no UI/icon libraries.
- **Typography:** [Fraunces](https://fonts.google.com/specimen/Fraunces)
  variable serif for display, [Manrope](https://fonts.google.com/specimen/Manrope)
  for body — loaded from Google Fonts with `preconnect`.
- **Content collections** (`src/content/`) with Zod schemas for
  type-safe `services` and `products` data.
- **Astro Image** for the local logo; Shopify CDN images hotlinked with
  `loading="lazy"` for now (phase 2 will localize them).
- Node 20+.

```
src/
  assets/         logo-light.png, logo-dark.png
  components/     Header, Hero, QuickActions, Services, ServiceCard,
                  Barbers, Story, Products, ProductCard, Reviews,
                  ReviewCard, Location, FinalCTA, Footer, MobileBookCTA
  content/
    config.ts     Zod schemas
    services/     8 .json entries
    products/     12 .json entries
  layouts/        BaseLayout.astro (SEO meta, OG/Twitter, JSON-LD)
  pages/          index.astro
  styles/         tokens.css, global.css
public/           favicon.svg, robots.txt
docs/             CLAUDE_CODE_PROMPT.pdf (build spec — not shipped)
```

---

## Run

```bash
npm install
npm run dev        # local dev server at http://localhost:4321
npm run build      # static build → ./dist
npm run preview    # serve ./dist locally
```

The project builds cleanly on either Netlify or Vercel with no extra
config — point them at `npm run build` and serve `dist/`.

---

## In scope (this build)

- Homepage at `/` with section order: Header → Hero → Quick Actions →
  Services → Barbers → Story → Products → Reviews →
  *(Facebook photo grid placeholder)* → Location → Final CTA → Footer →
  Mobile sticky Book CTA.
- 8 services and 12 products as content-collection JSON, with the spec's
  6 featured services and 4 featured products surfaced on the homepage.
- Three-barber roster (Michael, Rick, Clayton) — pricing shown, durations
  intentionally omitted until owner finalizes.
- Brand wordmark in the header (per spec — full emblem reserved for the
  hero), gold-accented dark palette tuned to the logo, italic display
  treatment for "Keep the Style." across hero / sections / final CTA.
- SEO: title, description, canonical, theme-color, Open Graph + Twitter
  cards, `LocalBusiness`/`HairSalon` JSON-LD with services and social
  profiles.
- Accessibility: semantic landmarks, skip link, gold focus rings,
  `prefers-reduced-motion` respected, alt text on the emblem and
  product images.
- All Book buttons → `https://modern-classic.square.site`. All product
  cards → existing Shopify product URLs. Policy/help links →
  existing Shopify pages.

---

## Out of scope — phase 2 TODO

Tracked items not part of this build:

- **Facebook photo grid.** Pull recent shop photos from the Facebook
  Graph API at build time (System User token, `type=uploaded`,
  pagination). `FB_PAGE_ID` + `FB_ACCESS_TOKEN` in env. Trigger via
  Netlify build hook / Vercel Cron / GitHub Actions on a schedule.
  Placeholder comment is already in `index.astro` between Reviews and
  Location.
- **Localize Shopify product images** for `astro:assets` optimization
  instead of hotlinking the CDN.
- **Migrate Shopify policy pages** (FAQs, Shipping, Returns, Wholesale,
  Privacy, Terms) to native Astro pages.
- **Real shop photography** to replace the monogram panel in the Story
  section and the stylized SVG map placeholder in the Location section
  (swap that for a real Google Maps embed).
- **Full weekly hours** and a **phone number** (currently TODO comments
  in `Location.astro` and the JSON-LD).
- **Per-service Square deep links** instead of one shared booking URL.
- **Newsletter signup** integration once a provider is chosen.
- **About / Contact / Services index** pages, plus a **Blog / Styling
  Tips** page (the existing Shopify blog has two starter posts to
  port).
- **Per-barber pricing/duration polish** once the team confirms.
- **Barber headshots** to replace the initial monograms in
  `Barbers.astro`, and individual bios + Square deep links per barber.

---

## Design notes

- Palette is warm near-black (`#0b0a08`) with a multi-stop gold scale
  (`#e6c785 → #c9a35c → #8a6e35`) sampled around the logo's bronze.
  No pure black, no neutral greys — every surface has a warm undertone
  so the gold sits in the world it belongs to.
- Headlines split a roman display weight against an italic, lighter,
  gold-tinted accent (`Get the Cut. *Keep the Style.*`) — the same
  treatment recurs in section headings, the footer tagline, and the
  final CTA.
- Decorative motifs are hand-drawn inline SVG (corner brackets in the
  hero, MC monogram in the Story panel, initial crests for each barber,
  the Location map placeholder) — no icon library shipped.
- Hover states are restrained: a 1–3px lift, a hairline border-color
  shift to gold, a 3px arrow nudge. Section transitions are mostly
  opacity / translate — all collapse to instant under
  `prefers-reduced-motion: reduce`.

---

## Verification (built into `dist/`)

```bash
npm run build
grep -oE 'https://modern-classic\.square\.site[^"]*' dist/index.html | wc -l   # 19 Book links
grep -oE 'id="(services|products|story|location|barbers)"' dist/index.html      # all anchors present
ls dist/_astro/logo-light*.webp                                                  # 5 responsive variants
```

---

## Booking system (Square integration)

The custom booking flow lives at `/book` (Vercel only — gh-pages preview
falls back to the Square-hosted booking site).

### Required env vars

Add to `.env` locally and to the Vercel project's environment variables.
`.env` is gitignored.

```
# Square personal access token. Production scope set: APPOINTMENTS_ALL_READ,
# APPOINTMENTS_WRITE, CUSTOMERS_READ, CUSTOMERS_WRITE, ITEMS_READ,
# EMPLOYEES_READ, MERCHANT_PROFILE_READ.
SQUARE_ACCESS_TOKEN=

# Phase 4 admin dashboard. Used as the password for HTTP Basic Auth at
# /admin/bookings. Username is "admin".
ADMIN_PASSWORD=
```

The booking flow uses **Square's built-in confirmation email** — we don't
send our own. No `RESEND_API_KEY` required for new bookings.

### Phase 5+ env vars (customer auth + portal)

```
# 32+ char random hex string, used to HMAC-sign session cookies + magic
# links. Generate with: openssl rand -hex 32
AUTH_SECRET=

# Resend API key. Sender domain `designedtoelevate.co` is verified on the
# Resend account (configured in Resend → Domains).
RESEND_API_KEY=
```

### Phase 6 env vars (live catalog cron)

The `/services` page reads from Square's catalog at build time. A daily
Vercel cron at 8 AM UTC (3-4 AM ET depending on DST) hits
`/api/cron/rebuild`, which fires a Vercel deploy hook so Michael's
catalog edits propagate within 24 hours.

```
# Vercel injects Authorization: Bearer $CRON_SECRET on its cron HTTP
# requests. We compare with constant-time equality. Without it, the
# rebuild endpoint returns 503.
CRON_SECRET=

# URL of a Vercel deploy hook (Project Settings → Git → Deploy Hooks).
# The cron endpoint POSTs here to trigger a fresh build.
VERCEL_DEPLOY_HOOK_URL=
```

Cron schedule lives in `vercel.json` under `crons[]`. To change the
trigger time, edit the cron expression there. Vercel Hobby tier limits
crons to once-daily granularity, which is what we use.

### Where things live

- `src/lib/square/` — typed wrapper around the Square HTTP API (no SDK).
  `client.ts`, `types.ts`, `locations.ts`, `team.ts`, `catalog.ts`,
  `availability.ts`, `customers.ts`, `bookings.ts`.
- `src/lib/booking/` — wire-format types, idempotency-key derivation,
  structured logging.
- `src/pages/api/square/` — server endpoints the wizard talks to:
  `health.ts`, `availability.ts`, `bookings.ts`, `customer-lookup.ts`.
- `src/pages/admin/bookings.astro` — password-protected booking activity
  dashboard.
- `src/components/booking/` — React wizard (5 steps, useReducer).
- `src/styles/booking.css` — wizard-only styles, scoped under `.bw`.

### Phase docs (read in order before changes)

1. `SQUARE_REFERENCE.md` — IDs, endpoints, gotchas. Source of truth for
   any Square-side fact.
2. `PHASE_1_API_WRAPPER.md` — wrapper layer.
3. `PHASE_2_BOOKING_WIZARD.md` — wizard UI.
4. `PHASE_3_BOOKING_WRITES.md` — real customer + booking writes.
5. `PHASE_4_POLISH.md` — edge cases, observability, admin.

### Quick smoke tests (dev server running)

```bash
# End-to-end wrapper smoke test
curl http://localhost:4321/api/square/health

# Live availability (Beard Trim & Edge, next 7 days)
curl "http://localhost:4321/api/square/availability?serviceVariationId=3QMIIG6HB5G47PHKQALEAJAI&startAt=$(date -u -d '+1 day' +%FT%TZ)&endAt=$(date -u -d '+8 days' +%FT%TZ)"
```
