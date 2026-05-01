# Phase 5 — Customer Auth, "My Bookings" Page, Reschedule/Cancel, Product Recommendations

**Goal:** Give returning customers a logged-in experience on the Modern Classic site. They sign in with a magic link sent to their email, see their upcoming and past bookings, can cancel or reschedule from the page, and see smart product recommendations from Modern Classic's Shopify store. Stays logged in for 90 days.

**Prerequisites:**
- Phases 1–4 are done. The booking wizard is live and writes real bookings to Square.
- `SQUARE_REFERENCE.md` and the four prior phase docs are in the project root.
- Resend account exists with `designedtoelevate.com` already verified as a sending domain.

**Out of scope:**
- Branded confirmation emails for *new* bookings (Square's automatic confirmations still handle that)
- SMS-based auth (email magic link only this round)
- Customer profile editing (name, phone, etc — read-only from Square's customer record)

---

## Paste this prompt into Claude Code

```
Read SQUARE_REFERENCE.md and the four prior phase docs (PHASE_1 through PHASE_4) in the project root before doing anything else. Phase 5 builds on top of all of them.

Your task is Phase 5: customer auth + a "My Bookings" page where logged-in customers can view, reschedule, and cancel their appointments, plus see recommended products from Modern Classic's Shopify store.

You have full autonomy on implementation details. The constraints below are hard rules. Everything else is your judgment.

============================================================
ENVIRONMENT VARIABLES (already present unless noted)
============================================================

Already set:
- SQUARE_ACCESS_TOKEN
- ADMIN_PASSWORD

To add to .env locally AND Vercel before this phase works:
- RESEND_API_KEY — the user will add this. Read from import.meta.env. Throw a clear error if missing on any endpoint that needs it.
- AUTH_SECRET — generate one with `openssl rand -hex 32` or `crypto.randomBytes(32).toString('hex')`. The user will paste it into Vercel. Used for signing session cookies and magic-link tokens. If missing, server endpoints that need it must return 503 with a clear "auth not configured" message.

============================================================
PART A — CUSTOMER AUTH (magic link + signed cookie)
============================================================

Build a magic-link auth system. Customer enters email → server sends a one-time link → clicking it sets a 90-day signed session cookie → they stay logged in.

Files to build:

1. src/lib/auth/session.ts
   - signSession(payload): string — HMAC-SHA256 signed JWT-style token (header.payload.signature, base64url). Use AUTH_SECRET. No external library — write it with native crypto.
   - verifySession(token): { customerId, email } | null — validates signature and expiration; returns null on any failure.
   - SESSION_DURATION_DAYS = 90.
   - Cookie name: mc_session.
   - Cookie attributes: HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=90 days.
   - Sliding refresh: every authenticated request that comes through the auth middleware should reissue the cookie with a fresh 90-day expiration. So an active customer never has to re-verify.

2. src/lib/auth/magicLink.ts
   - signMagicToken({ email, nonce }): string — HMAC-signed, 15-minute expiration. Different secret namespace than session tokens (e.g. prefix the payload with "magic:" before signing) so a session cookie can't be reused as a magic link or vice versa.
   - verifyMagicToken(token): { email } | null.
   - Magic links are single-use: maintain a Set of recently-used nonces in memory (Map<nonce, expiresAt>), expire entries past 15 minutes. Acceptable in-memory because Vercel function instances are short-lived and a token used twice within one instance is the realistic attack vector. A persistent store can come in Phase 6 if needed.

3. src/lib/auth/middleware.ts
   - getSession(request): { customerId, email } | null — reads mc_session cookie, verifies, returns payload or null.
   - requireSession(request): throws a 401 Response if not authenticated; otherwise returns the session.
   - Use this in every authenticated API endpoint and the bookings page.

4. src/lib/email/resend.ts
   - Wrapper around Resend's HTTP API at https://api.resend.com/emails. No SDK — native fetch.
   - sendMagicLink({ to, magicUrl, customerName? }): Promise<{ id: string }>
   - From: bookings@designedtoelevate.com
   - From display name: "Modern Classic Barbershop"
   - Reply-to: shop's email from /v2/locations (modernclassicbarbershop@protonmail.com).
   - On Resend failure, throw a typed error with the response body. Don't swallow.

5. src/lib/email/templates.ts
   - magicLinkHtml({ magicUrl, customerName? }): string — branded HTML matching the site's masculine/vintage barbershop aesthetic. Dark background with warm accent. Clear CTA button. Include "If you didn't request this, ignore this email." Inline CSS for email-client compatibility.
   - magicLinkText(...): string — plaintext fallback.

6. src/pages/api/auth/request.ts (POST)
   - Body: { email }
   - Validate email format. If invalid, return 400.
   - Look up the customer in Square via findCustomerByEmail. If they don't exist, still return 200 with a generic "If we found an account, we sent a link" message — don't leak whether the email is registered (anti-enumeration).
   - If found, generate a magic token, build the URL: ${SITE_URL}/auth/verify?token=${token}, send via Resend.
   - Rate-limit by email: at most 1 request per 60 seconds. In-memory Map<email, lastRequestedAt> is fine for now. Return 429 on rate limit.
   - Always return { ok: true, message: "If we found an account, we sent a link to your email." }.

7. src/pages/auth/verify.astro
   - Reads ?token= from the URL.
   - Verifies the magic token.
   - On success: looks up the Square customer by email, sets the session cookie, redirects to /my-bookings.
   - On failure: renders an "Invalid or expired link" page with a "Request a new link" CTA back to the login page.

8. src/pages/sign-in.astro
   - Simple form: email field + "Send me a sign-in link" button.
   - Posts to /api/auth/request via fetch (no full page reload).
   - On 200, swap the form for "Check your email — we sent a sign-in link to <email>. It expires in 15 minutes."
   - Show same message regardless of whether the email is registered.

9. src/pages/api/auth/logout.ts (POST)
   - Clears the mc_session cookie (Set-Cookie with Max-Age=0).
   - Returns 200 + redirect to homepage.

============================================================
PART B — "MY BOOKINGS" PAGE
============================================================

Files to build:

10. src/lib/square/customerBookings.ts
    - getCustomerBookings(customerId): Promise<{ upcoming: BookingDetail[], past: BookingDetail[] }>
    - Calls GET /v2/bookings?location_id=...&customer_id=... Square supports filtering by customer_id. Confirm with the API docs and adjust if the param name differs.
    - Hydrates each booking with service name (from catalog), barber name (from team members), price display, duration. Use Phase 1's wrappers.
    - Splits into upcoming (start_at >= now AND status NOT IN [CANCELLED_BY_CUSTOMER, CANCELLED_BY_SELLER, NO_SHOW, DECLINED]) vs past.
    - Sort upcoming ascending (soonest first), past descending (most recent first).
    - Returns BookingDetail with: id, version, startAtUtc, startAtLocal (America/New_York), serviceName, serviceVariationId, serviceVariationVersion, barberId, barberName, durationMinutes, priceDisplay, status, customerNote.

11. src/pages/api/square/customer/bookings.ts (GET)
    - Auth-gated via requireSession.
    - Calls getCustomerBookings(session.customerId), returns JSON.
    - On 401, the page handles the redirect to /sign-in. The endpoint just returns 401.

12. src/pages/my-bookings.astro
    - Server-side: calls getSession. If null, redirect to /sign-in?redirect=/my-bookings.
    - If authenticated: server-renders the initial bookings list (calls getCustomerBookings server-side), passes to a React component for interactive cancel/reschedule.
    - Page layout: customer's name + email at the top with a small "Sign out" link, then "Upcoming" and "Past" sections, then the product recommendations panel.

13. src/components/bookings/MyBookingsList.tsx (client:load)
    - Renders BookingCards from initial server-rendered data.
    - Refetches /api/square/customer/bookings after any cancel or reschedule.
    - "Past" section is collapsed by default ("Show past appointments" toggle).

14. src/components/bookings/BookingCard.tsx
    - Shows: date+time, service, barber, duration, price, customer note.
    - Two action buttons: Cancel and Reschedule.
    - Disabled-state logic: if start_at is within 24 hours from now, disable both buttons and show inline tooltip: "Within 24 hours? Call the shop at 740-297-4462 to cancel or reschedule." Hours threshold is exact — uses startAtUtc - now() >= 24 * 3600 * 1000.
    - Cancel button → opens a confirmation modal with the cancellation policy reminder, then on confirm POSTs to /api/square/bookings/[id]/cancel. On success, refresh the list.
    - Reschedule button → opens the booking wizard in "reschedule mode" (see Part C).

============================================================
PART C — RESCHEDULE FLOW
============================================================

This is the trickiest part. There's no Square "reschedule" endpoint — we cancel-old + create-new. To avoid the failure mode where the cancel succeeds but the new booking fails (customer loses their slot), do the operations in this order:

1. Create the new booking first (at the new time)
2. Only if step 1 succeeds, cancel the old booking
3. If step 1 fails, return the error and leave the original booking intact

Files to build/modify:

15. src/lib/square/bookings.ts (modify, from Phase 3)
    - Add cancelBooking({ bookingId, bookingVersion, idempotencyKey }): Promise<Booking>
      - POST /v2/bookings/{bookingId}/cancel with body { booking_version, idempotency_key }
      - bookingVersion comes from the booking we're cancelling (pessimistic concurrency control).
    - Existing createBooking stays as-is.

16. src/pages/api/square/bookings/[id]/cancel.ts (POST)
    - Auth-gated. Verify the booking belongs to the authenticated customer (fetch the booking, compare customer_id to session.customerId; if mismatch, 403).
    - Enforce 24-hour rule server-side: refuse to cancel if start_at is within 24 hours. Return 400 with code: "TOO_LATE_TO_CANCEL".
    - Call cancelBooking. Return { ok: true, bookingId }.
    - Log the cancellation with redacted email (Phase 4 logging utility).

17. src/pages/api/square/bookings/reschedule.ts (POST)
    - Auth-gated.
    - Body: { oldBookingId, oldBookingVersion, newSlot: { startAtUtc }, service: { variationId, version, durationMinutes }, barber: { id }, customerNote? }
    - Verify the old booking belongs to the authenticated customer.
    - Enforce 24-hour rule on the OLD booking: can't reschedule if existing appointment is within 24h. Return 400, code: "TOO_LATE_TO_RESCHEDULE".
    - Generate idempotencyKey deterministically from (customerId + oldBookingId + newSlot.startAtUtc).
    - Step 1: createBooking with the new details. If it fails:
      - Return { ok: false, error: { code, detail } }, original booking is untouched.
    - Step 2: cancelBooking on the old one. If THIS fails (rare, but possible):
      - Don't roll back the new booking — the customer has their new appointment.
      - Log a "manual cleanup needed" warning so admin sees it.
      - Return { ok: true, newBookingId, warning: "Old appointment may still appear briefly. We've notified the shop." }
    - On both succeeding: return { ok: true, newBookingId, oldBookingId }.

18. src/components/booking/BookingWizard.tsx (modify, from Phase 2)
    - Add a "rescheduleMode" prop. When set, the wizard:
      - Skips Step 1 (Service) — preselected from the existing booking.
      - Skips Step 2 (Barber) — preselected. Optionally allow changing barber via a small "Change barber" link if the new variation supports it.
      - Starts on Step 3 (Date/Time).
      - Step 4 (Customer Info) is also skipped — we already know who they are.
      - Step 5 (Confirm) shows: "You're rescheduling: [old appointment summary] → [new appointment summary]." Confirm button POSTs to /api/square/bookings/reschedule instead of the create endpoint.
    - Reschedule flow can be initiated by passing initial state via URL (e.g., /book?reschedule=<oldBookingId>) or by mounting the wizard as a modal from the bookings page. Your call which is cleaner.

============================================================
PART D — PRODUCT RECOMMENDATIONS
============================================================

Show 3 recommended products on the My Bookings page below the bookings list. Logic: smart blend of barber + service.

Files to build:

19. src/lib/square/products.ts
    - getRetailProducts(): Promise<Product[]> — calls GET /v2/catalog/list?types=ITEM,ITEM_VARIATION (already cached / similar to getServices but filtered to product_type === "REGULAR"). Each product carries: id, name, priceCents, ecomUri (from item_data.ecom_uri — this is what we link to), imageUrl (from ecom_image_uris[0]), categories (from item_data.categories), associatedBarberCode? (parsed from name prefix — see below).
    - Modern Classic's product naming convention encodes the barber: "MIC-CLAY", "RICK-FIBER POMADE", "CLAYTON-POWDER", etc. Parse:
      - Names starting with "MIC-" or "MIC " → Michael
      - Names starting with "RICK-" or "RICK " or "RICK " → Rick
      - Names starting with "CLAYTON-" or "CLAYTON " → Clayton
      - Names starting with "BACKBAR-" → exclude (these are $0 internal-only items)
      - Everything else → no associated barber (general retail)
    - Filter out items where price === 0 OR ecom_visibility === "UNAVAILABLE" OR is_archived === true.

20. src/lib/recommendations/forBooking.ts
    - recommendForBooking({ barberId, serviceVariationId, allProducts }): Product[]
    - Logic (smart blend):
      a. Determine "intent" from the most recent upcoming or last past booking:
         - Beard service (variation IDs from SQUARE_REFERENCE.md: 3QMIIG6HB5G47PHKQALEAJAI = Beard Trim & Edge; or any variation under "Haircut & Beard" item) → prefer products with "BEARD", "OIL", "BUTTER", "BALM" in name.
         - Shampoo + Style (CLAOC767V22KP4NERKQZ7QE2) → prefer products with "SHAMPOO", "CONDITIONER", "STYL CREAM" in name.
         - Straight Razor Shave (TPW66NFYZQCM53WYEMXKMZ5P) → prefer "AFTERSHAVE", "SHAVE CREAM".
         - Default (haircuts) → prefer "POMADE", "CLAY", "MATTE PASTE", "POWDER".
      b. Map barberId to barber code (Michael/Rick/Clayton/Bill — Bill has no products).
      c. Filter products by associated barber if known. If the customer's barber is "Any" (no preference), don't filter on barber.
      d. From that filtered set, prioritize products matching the service intent.
      e. Return top 3. If there aren't 3 matches, fall back to: same-barber non-matching → other-barbers matching service → other-barbers any.

21. src/components/bookings/ProductRecommendations.tsx
    - Receives a recommendedProducts: Product[] prop.
    - Renders a section titled "Continue your look at home" (or similar — give it a nice barbershop-feeling header).
    - Shows the 3 products as cards: image, name (cleaned up — strip the barber prefix for display, e.g., "RICK-FIBER POMADE" displays as "Fiber Pomade — Rick's Line"), price, "Shop" button that opens product.ecomUri in a new tab (target="_blank" rel="noopener noreferrer").
    - **IMPORTANT: Shopify URL.** Modern Classic's actual storefront is mdrnclassic.com (Shopify), not the Square Site URL stored in ecom_uri. Until we map Square product IDs to Shopify product handles, the cleanest fallback is to link to the Shopify homepage with a search query: https://mdrnclassic.com/search?q=<encoded product name without barber prefix>. The user will likely refine this later. Add a TODO in the code: "// TODO: replace search-link fallback with direct Shopify product URLs once SKU mapping is provided."
    - If recommendations array is empty (shouldn't happen but handle gracefully), render nothing — no broken empty state.
    - Mobile: 1-column stack. Desktop: 3-column grid.

22. src/pages/my-bookings.astro (modify Part B step 12)
    - After server-rendering the bookings list, also call getRetailProducts() and recommendForBooking(...) using either the soonest upcoming booking or, if none, the most recent past booking. Pass to ProductRecommendations.
    - If the customer has zero bookings (shouldn't happen — they only get here if logged in via an existing customer record), still show 3 best-seller-ish products: any 3 visible items not in BACKBAR-, no barber filter.

============================================================
PART E — UI ENTRY POINTS & POLISH
============================================================

23. src/components/Header.astro (modify)
    - Add "My Bookings" link in nav, right side, next to "Book a Visit."
    - Visible on all pages.
    - Clicking links to /my-bookings (which redirects to /sign-in if not authenticated).

24. src/components/MobileBookCTA.astro (modify)
    - Mobile nav also gets "My Bookings."

25. src/components/booking/Step5Confirm.tsx (modify, from Phase 2)
    - On the success screen (after a successful new booking), in addition to the existing "Book another" button, add a "View My Bookings" button that links to /my-bookings.

26. CSS / styling
    - All new components match the existing Modern Classic aesthetic (dark neutrals, warm accent, serif headings, generous whitespace).
    - Mobile first, 375px tested.
    - "Sign out" link should look like a secondary action — small, subtle, not a giant red button.

============================================================
CONSTRAINTS (hard rules)
============================================================

- Server-side only for token reads. AUTH_SECRET, SQUARE_ACCESS_TOKEN, RESEND_API_KEY must never reach the browser bundle. After the build, grep dist/ for "AUTH_SECRET", "RESEND", and "EAAA" — should return zero hits.
- No new heavy dependencies. Native fetch, native crypto, native Intl. No JWT library, no Resend SDK, no auth library (NextAuth, Lucia, etc).
- Strict TypeScript. No `any` in the diff.
- HMAC, not bcrypt — we're not storing passwords, just signing tokens.
- All Square calls go through Phase 1 wrappers. Never raw fetch to connect.squareup.com from any new file.
- Cookie attributes: HttpOnly + Secure + SameSite=Lax. Always.
- Anti-enumeration: /api/auth/request returns the same response whether email exists or not.
- Rate limiting: 1 magic-link request per email per 60 seconds. Surface as 429 with a friendly message.
- 24-hour rule enforced both client-side (UI affordance) AND server-side (real protection).
- Reschedule order: create-new, then cancel-old. Never the other order.
- Magic link tokens are single-use within the 15-minute window.
- Sliding cookie expiration: every authenticated request reissues the cookie with a fresh 90 days.
- Logging: redact emails in logs (a***@gmail.com), never log full tokens, never log Square access token.

============================================================
WHEN YOU FINISH
============================================================

1. Run `npm run build`. Zero errors.
2. Verify token-leak greps return zero hits.
3. End-to-end test:
   a. Sign out if you're already authenticated (or use a fresh browser).
   b. Visit /sign-in, enter the test email (bilsonxnc@gmail.com — there's a real customer record from Phase 3).
   c. Receive email, click magic link, land on /my-bookings logged in.
   d. Verify upcoming + past bookings render correctly.
   e. Verify product recommendations show 3 items, click one, confirm it opens Shopify search in a new tab.
   f. Create a test booking 2+ days out via /book.
   g. From /my-bookings, click Reschedule on it. Pick a new slot. Confirm. Verify both bookings update in Square (new exists, old cancelled).
   h. Click Cancel on another test booking. Confirm. Verify it's cancelled in Square.
   i. Try to cancel a booking less than 24 hours out — expect the button to be disabled with the tooltip.
   j. Sign out. Visit /my-bookings. Should redirect to /sign-in.
   k. Sign back in. Verify session persists across browser restart (close tab, reopen, navigate to /my-bookings without signing in again).
4. Cancel any test bookings from Square dashboard so they don't sit there.
5. Report files created/modified, test results step by step, and any deviations or edge cases encountered.
6. Note: The Shopify product link is a search-fallback. Flag this as a follow-up so I know to provide proper Shopify product handles later.
```

---

## Definition of done

- [ ] `RESEND_API_KEY` and `AUTH_SECRET` set in Vercel and locally
- [ ] Magic-link sign-in works end-to-end with a real email
- [ ] Session cookie persists 90 days, sliding (verify by inspecting Set-Cookie header)
- [ ] Anti-enumeration: same response for valid and invalid emails on `/api/auth/request`
- [ ] Rate-limit returns 429 after rapid repeat requests
- [ ] `/my-bookings` shows real upcoming and past appointments for the test customer
- [ ] Cancel flow works, hits Square's cancel endpoint, refreshes the list
- [ ] Reschedule flow uses the create-new-then-cancel-old pattern verifiably (check Square logs)
- [ ] 24-hour rule enforced both client- and server-side
- [ ] Product recommendations show 3 items, prioritized correctly by barber + service
- [ ] Product cards link to mdrnclassic.com (search fallback for now)
- [ ] "Sign out" works
- [ ] No tokens or secrets in client bundle
- [ ] Lighthouse on `/my-bookings` ≥ 90 / 95 / 95 / 95

When all are true, customers can fully self-serve their bookings on a branded Modern Classic page that beats Square's portal.
