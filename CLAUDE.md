# CLAUDE.md

Orientation for AI assistants working in this repo. Keep it scannable; cross-link
to `PHASE_*.md` and `SQUARE_REFERENCE.md` for depth instead of restating them.

## What this repo is

Single-tenant marketing + booking site for **Modern Classic Barbershop**.

- **Astro 5** with SSR on Vercel; **React 18** islands for interactive flows
  (booking wizard, customer portal).
- Integrations: **Square Appointments** (catalog / team / availability /
  bookings / customers), **Resend** (transactional email), **Upstash Redis**
  (review-log dedup).
- Production: `https://mdrnclassic.com`. Marketing-only static preview:
  GitHub Pages.
- Phase-by-phase narrative of how this was built: `PHASE_1_API_WRAPPER.md`
  through `PHASE_7_REVIEW_REQUESTS.md`. Square shapes / scopes / IDs /
  business hours: `SQUARE_REFERENCE.md`.

## Build targets (three modes — important)

`astro.config.mjs` switches on `DEPLOY_TARGET`:

| Mode | `output` | Adapter | Use |
| --- | --- | --- | --- |
| _default_ (Vercel) | `server` | `@astrojs/vercel` | production SSR |
| `DEPLOY_TARGET=gh-pages` | `static` | none | marketing-only preview on GH Pages |
| `DEPLOY_TARGET=local-preview` | `server` | `@astrojs/node` | `astro preview` locally (Vercel adapter doesn't support preview) |

The GH Pages workflow (`.github/workflows/deploy.yml`) **deletes** before
build:

```
src/pages/api/   src/pages/admin/   src/pages/auth/
src/pages/book.astro   src/pages/sign-in.astro   src/pages/my-bookings.astro
```

**Implication:** any new server-only route (uses secrets / Square / cookies)
must be inside one of those paths, or the strip list must be extended. The
gh-pages build will silently fail if a dynamic route is left in static output.

## Commands

- `npm run dev` — dev server at http://localhost:4321
- `npm run build` — production build (respects `DEPLOY_TARGET`)
- `npm run preview` — serve `dist/` (set `DEPLOY_TARGET=local-preview` for SSR)
- `npm run astro -- check` — TypeScript + Astro diagnostics

There is **no test runner**, no ESLint, no Prettier. `astro check` is the
single quality gate. Smoke-test by hitting `/api/square/health` and walking
the booking wizard end-to-end.

## Source layout

```
src/
  assets/         logos, hero photo, gallery photos
  components/
    *.astro       marketing sections (Hero, Services, Barbers, Reviews, …)
    booking/      React wizard — 5 steps + WaitlistSheet + wizardState reducer
    bookings/     React customer-portal cards (MyBookingsList, RebookUsualCard, …)
    availability/ Astro inline "next available" widgets
    home/         homepage-only Astro pieces
  content/        Astro content collections (services, products) — Zod in config.ts
  layouts/        BaseLayout.astro — SEO meta + JSON-LD (LocalBusiness/HairSalon)
  lib/
    square/       hand-rolled Square API wrapper (no SDK):
                  client, types, catalog, team, locations, availability,
                  customers, bookings, customerBookings, customAttributes, products
    auth/         HMAC-signed session cookies + magic-link tokens (no JWT lib)
    booking/      idempotency, wizard preselect, "usual" detection, rebook eligibility
    availability/ in-memory TTL cache, nextAvailable, timezone helpers
    email/        Resend wrapper + HTML/plain-text templates (incl. reviewRequest)
    marketing/    review-log (Upstash), eligibility, click + unsubscribe tokens
    catalog/      live service fetcher
    recommendations/  product suggestions per booked service
    admin/        HTTP Basic Auth helper for /admin
  pages/
    *.astro       index, book, services, shop, barbers, visit, gallery,
                  sign-in, my-bookings, unsubscribe
    sitemap.xml.ts
    admin/        admin dashboard pages (Basic Auth)
    api/
      square/     availability, bookings (+ cancel, reschedule, quick-rebook),
                  customer-lookup, customer/bookings, next-available, health
      auth/       request (magic link), logout
      cron/       rebuild (catalog sync), review-requests
      admin/      init-custom-attributes
      marketing/  unsubscribe
      waitlist.ts
    r/            shortlink redirects
  styles/         tokens.css, global.css, booking.css, portal.css
```

## Conventions

- **TypeScript strict** via `astro/tsconfigs/strict`. No path aliases — use
  relative imports.
- **No SDKs for Square.** Types are hand-rolled in `src/lib/square/types.ts`
  to keep the bundle small. New Square calls go through
  `squareFetch<T>()` in `src/lib/square/client.ts`; do **not** add
  `@square/square` or similar.
- **Astro vs React split:** `.astro` for marketing, layouts, server data
  fetching. `.tsx` for stateful interactive UI; hydrate with `client:load`
  (or a lighter directive when sufficient).
- **Styling:** plain CSS only. No Tailwind, no CSS-in-JS. Tokens in
  `src/styles/tokens.css`. Respect `prefers-reduced-motion`.
- **State:** `useReducer` for wizard-style flows
  (`src/components/booking/wizardState.ts`). Server state passes via Astro
  page props.
- **API routes:** always `export const prerender = false`. Catch
  `SquareApiError` and map to HTTP using the local `fail(status, code,
  detail)` pattern in `src/pages/api/square/bookings.ts` — slot taken
  → 409, validation → 422, Square auth/outage → 502.
- **Idempotency:** every booking write goes through
  `bookingIdempotencyKey()` in `src/lib/booking/idempotency.ts`. Never POST
  to `/v2/bookings` without a deterministic key — Square retries will
  double-book otherwise.
- **Auth:** signed session cookies (`mc_session`, 90 days, HMAC-SHA256) and
  magic-link tokens. Live in `src/lib/auth/{session,magicLink,middleware}.ts`.
  Reuse `signSession` / `verifySession`; do not roll new crypto.
- **Naming:** kebab-case routes; PascalCase components (both `.astro` and
  `.tsx`); camelCase functions; UPPER_SNAKE constants; snake_case only when
  mirroring Square payload fields.
- **Comments / docs:** existing style is terse. Don't add planning, summary,
  or progress docs unless asked.

## Environment variables

All in `.env.example`. All are **server-only**; never read from React or any
`client:*` island.

| Var | Purpose |
| --- | --- |
| `SQUARE_ACCESS_TOKEN` | Square personal access token (production scopes listed in `.env.example`) |
| `ADMIN_PASSWORD` | HTTP Basic Auth password for `/admin` (username `admin`) |
| `RESEND_API_KEY` | Magic-link sign-in + booking confirmation emails |
| `AUTH_SECRET` | HMAC key for session cookies + magic-link tokens (`openssl rand -hex 32`) |
| `CRON_SECRET` | Auth on the daily `/api/cron/rebuild` job |
| `VERCEL_DEPLOY_HOOK_URL` | Triggered by `rebuild` cron when catalog changes |
| `GOOGLE_REVIEW_URL` | CTA destination in review-request emails |
| `UNSUBSCRIBE_SECRET` | HMAC key for unsubscribe + click-tracking tokens |
| `REVIEW_CRON_SECRET` | Auth on the daily `/api/cron/review-requests` job |
| `KV_REST_API_*`, `KV_URL`, `REDIS_URL` | Upstash Redis — auto-injected by Vercel |

## Cron jobs (Vercel — `vercel.json`)

- `/api/cron/rebuild` — daily `0 8 * * *` UTC. Refreshes Square catalog /
  availability caches.
- `/api/cron/review-requests` — daily `0 14 * * *` UTC. Sends post-visit
  review emails (gated by consent + Redis dedup log).

Each guards on its own secret so they can be rotated independently.

## Where to look for what

- Add/edit a service → `src/content/services/*.json` (schema in
  `src/content/config.ts`).
- Add/edit a product → `src/content/products/*.json`.
- Touching the wizard → `src/components/booking/`; state machine in
  `wizardState.ts`.
- Booking POST flow → `src/pages/api/square/bookings.ts` →
  `src/lib/square/{customers,bookings}.ts` → `src/lib/email/resend.ts`.
- "Next available" widget → `src/lib/availability/nextAvailable.ts` +
  `src/components/availability/NextAvailableLine.astro`.
- Email templates → `src/lib/email/templates.ts` and
  `src/lib/email/templates/reviewRequest.ts`.
- SEO / JSON-LD → `src/layouts/BaseLayout.astro`.
- Square shapes / scopes / hours / IDs → `SQUARE_REFERENCE.md`.
- Per-feature deep context → `PHASE_1_…` through `PHASE_7_…` at the repo root.

## Things that bite

- **gh-pages route stripping** (above). New dynamic routes break the GH
  Pages preview unless added to the strip list.
- **Square availability is capped at 31 days** — don't query past it.
- **In-memory cache** (`src/lib/availability/cache.ts`) is per-warm-instance
  only; do not assume cross-request global coherence.
- **No automated tests.** Manual smoke = `/api/square/health` + a full
  wizard run-through.
- **Single-tenant.** Modern Classic location ID and a couple of team-member
  exclusions (e.g. Bill Chicha) are hardcoded in
  `src/lib/square/{locations,team}.ts`. Don't generalize without a reason.
- **Signed tokens share secrets across purposes** with purpose tags
  (`AUTH_SECRET`, `UNSUBSCRIBE_SECRET`). When adding a new signed token,
  pick a distinct purpose tag — don't reuse an existing one.

## Git workflow

- Commit style: short imperative one-liners, no scope prefix
  (e.g. `Phase 7: marketing consent + automated review requests`,
  `Skip Step 4 (Details) when the customer is signed in`). Match it.
- Don't push to `main`. Work on a feature branch.
- Don't open PRs unless explicitly asked.
