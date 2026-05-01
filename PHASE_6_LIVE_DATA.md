# Phase 6 — Rebook Your Usual, Live Availability, Live Catalog Sync

**Goal:** Three features that turn the Modern Classic site from a booking form into a real customer app:
1. **6a — Rebook Your Usual:** A returning-customer shortcut on `/my-bookings` that detects their usual service+barber and surfaces 3 next-available slots for one-tap rebook.
2. **6b — Live availability on public pages:** Barber cards and the homepage show real-time "next available" data pulled from Square.
3. **6c — Live catalog sync:** Services page and any other price/duration display read from Square's catalog instead of hardcoded data, with daily auto-rebuild so Michael's price edits propagate without a developer touching code.

All three share the same data layer (a cached availability + catalog fetch), so they're built and shipped together.

**Prerequisites:**
- Phases 1–5 are done and verified.
- `SQUARE_REFERENCE.md` and the five prior phase docs are in the project root.
- Resend domain `designedtoelevate.co` is verified, magic-link auth works in production.

**Out of scope:**
- Smart reminder emails ("it's been 3 weeks, time for a cut?") — that's Phase 7.
- Loyalty / birthday / anniversary hooks — Phase 7+.
- Webhook-based catalog updates (we're doing time-based daily rebuild instead, simpler and reliable).

---

## Paste this prompt into Claude Code

```
Read SQUARE_REFERENCE.md and the five prior phase docs (PHASE_1 through PHASE_5) in the project root before doing anything else. Phase 6 builds on top of all of them and adds three connected features.

Your task is Phase 6: rebook-your-usual, live availability on public pages, and live catalog sync. All three share an availability cache, so they're built together as one phase.

You have full autonomy on implementation details. Hard constraints below are real. Definition of done is at the bottom.

============================================================
PART A — SHARED AVAILABILITY CACHE (foundation for 6a + 6b)
============================================================

Build an in-memory caching layer for "next available" calculations. Both the rebook feature and the live-availability features hit this.

Files to build:

1. src/lib/availability/cache.ts
   - Module-level Map<string, { value: T, expiresAt: number }> — in-memory cache. Vercel function instances are short-lived but warm; repeat requests within the TTL hit the same value.
   - Generic helper: `cached<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T>` — returns cached if present and unexpired, otherwise computes, stores, returns.
   - Cleanup: when computing a fresh value, opportunistically delete any expired entries from the map (keep memory bounded).

2. src/lib/availability/nextAvailable.ts
   - `getNextAvailability(barberId: string): Promise<{ slot: AvailabilitySlot | null, withinSevenDays: boolean }>`
     - Calls searchAvailability (Phase 1) for that barber across all services they offer, looking 14 days out.
     - Returns the soonest slot found, plus a flag for whether it's within 7 days.
     - If no slots within 14 days, returns { slot: null, withinSevenDays: false }.
   - `getNextSlotsForCombo({ serviceVariationId, teamMemberId, count }): Promise<AvailabilitySlot[]>`
     - Returns up to `count` next slots for a specific service+barber combo, looking 14 days out.
     - Used by the rebook feature.
   - `getSoonestAcrossBarbers(): Promise<{ barber: Barber, slot: AvailabilitySlot } | null>`
     - For each barber, finds their next slot. Returns the barber with the soonest slot overall.
     - Used by the homepage hero for guest visitors.
   - All three functions wrapped in the cache helper with TTL of 600 seconds (10 minutes).
   - Cache keys: `next-avail:${barberId}`, `combo-slots:${variationId}:${teamMemberId}:${count}`, `soonest-across-barbers`.

3. src/lib/availability/timing.ts
   - `formatRelativeSlot(startAtUtc: string): string` — returns human-friendly strings like "Tomorrow 2:30 PM", "Friday 10:00 AM", "Monday 9:00 AM" (always in America/New_York).
   - "Today" / "Tomorrow" labels for next-day slots, day-of-week label for slots 2-6 days out, "Mon, May 12" format for slots 7+ days out.
   - Used everywhere we display a single slot.

============================================================
PART B — REBOOK YOUR USUAL (6a)
============================================================

Files to build:

4. src/lib/booking/usual.ts
   - `findUsualCombo(bookings: BookingDetail[]): { serviceVariationId, teamMemberId, lastVisitDate } | null`
   - Logic per the reviewer-tightened spec:
     a. Filter to past bookings only (start_at < now).
     b. Exclude statuses: CANCELLED_BY_CUSTOMER, CANCELLED_BY_SELLER, NO_SHOW, DECLINED.
     c. Group remaining by (serviceVariationId, teamMemberId).
     d. Pick the most-repeated combo. Tiebreaker: most recent occurrence wins.
     e. Return that combo + the lastVisitDate (most recent occurrence's start_at).
     f. Return null if zero qualifying bookings.
   - Edge case: if the chosen barber's teamMemberId is no longer in the active team list (we look this up via getBarbers), discard and pick the next-most-frequent combo with an active barber. If no active-barber combos remain, return null.

5. src/lib/booking/rebookEligibility.ts
   - `shouldShowRebookCard({ usualCombo, upcomingBookings }): boolean`
   - True only when ALL of:
     - usualCombo is not null (they have past valid bookings)
     - upcomingBookings array is empty (they don't already have an upcoming appointment)
   - This is the single source of truth for "show the card or not." Kept as a pure function so it's easy to test and reason about.

6. src/components/bookings/RebookUsualCard.tsx (client:load)
   - Receives the usual combo, the customer's barber name, service name, lastVisitDate, and 3 prefetched quick slots (server-rendered for fast first paint).
   - Renders the card per the reviewer's copy:
     - Header: "Rebook your usual?"
     - Sub: "Same service. Same barber. Faster checkout."
     - Body: "[Service name] with [Barber name]"  ·  "Last visit: [Month Day]" (e.g., "Last visit: April 8") — use a real date, not "3 weeks ago"
     - If 3 quick slots available within 7 days: render them as 3 buttons, each labeled with formatRelativeSlot output (e.g., "Friday 2:00 PM"). Each button → opens a confirmation modal that on confirm POSTs directly to /api/square/bookings with idempotency, no full wizard re-traversal.
     - Always render a "See all times" secondary button → links to /book?service=<variationId>&barber=<teamMemberId> with the wizard's existing reschedule-mode-style preselect logic.
     - If the usual barber's first available slot is >7 days out: hide the 3-slot quick-pick, show a single line "Rick's first opening is [date]." with two buttons: "Book this time" and "See other barbers" (the second opens the wizard with service preselected but barber unchosen).
     - If no slots at all within 14 days: hide the card silently. Don't render an empty state — let the regular book CTA handle it.

7. src/components/bookings/NewCustomerCard.tsx
   - Renders when shouldShowRebookCard returns false AND there's no upcoming booking AND no past bookings (true new customer).
   - Header: "Book your next visit"
   - Sub: "Choose your service, barber, and time in just a few taps."
   - Single CTA: "Start Booking" → links to /book.

8. src/pages/my-bookings.astro (modify, from Phase 5)
   - Server-side, after fetching bookings: 
     a. Run findUsualCombo against the bookings.
     b. If a combo exists, fetch the next 3 slots via getNextSlotsForCombo (so they render server-side, no flash of loading).
     c. Compute shouldShowRebookCard.
     d. Pass props into the page.
   - Render order from top to bottom: [optional RebookUsualCard | NewCustomerCard], [Upcoming bookings list], [Past bookings collapsed], [Product recommendations].

9. src/pages/api/square/bookings/quick-rebook.ts (POST)
   - Auth-gated.
   - Body: { serviceVariationId, serviceVariationVersion, teamMemberId, durationMinutes, startAtUtc }
   - Validates the slot is still available (calls Square availability search with a 1-hour window around startAtUtc; if the slot doesn't appear, return 409 SLOT_TAKEN).
   - Generates idempotency key from (customerId + startAtUtc + serviceVariationId).
   - Creates the booking via Phase 3's createBooking.
   - Returns { ok: true, bookingId } or { ok: false, error }.

============================================================
PART C — LIVE AVAILABILITY ON PUBLIC PAGES (6b)
============================================================

Files to build:

10. src/components/availability/NextAvailableLine.tsx (client:load OR server-rendered, your call)
    - Small inline component: "🟢 Next available: Tomorrow 2:30 PM" — the green dot is a small CSS circle, accent color from the design system.
    - If withinSevenDays is false or slot is null, renders nothing. Component returns null silently.
    - Renders inside barber cards on /barbers and inside the homepage hero.

11. src/pages/barbers.astro (modify)
    - Currently prerendered as static. Switch to SSR (export const prerender = false) since we need live data per request. Confirm Vercel adapter handles this — should still be fast because the cache layer means most requests are sub-100ms cache hits.
    - For each of the 3 barbers (Michael, Rick, Clayton — exclude Bill), fetch getNextAvailability(barberId) in parallel using Promise.all.
    - Pass the slot data into each barber card. Render NextAvailableLine in each card.
    - If a barber has no slot within 7 days, the card just doesn't show the availability line — falls back to whatever it was before.
    - Also add a "Book with [Barber]" button on each card → links to /book?barber=<teamMemberId> (preselects barber, customer picks service).

12. src/pages/index.astro (modify) — Homepage hero
    - Currently prerendered. Switch to SSR.
    - Logic depends on auth state:
      a. If user is signed in (getSession returns a customerId): fetch their bookings, run findUsualCombo, get their usual barber's next slot via getNextAvailability. Render: "Rick's next opening: Tomorrow 2:30 PM →" linking to /book?barber=<theirUsualBarberId>.
      b. If user is signed in but findUsualCombo returns null (new customer who's signed in): fall back to (c).
      c. If user is not signed in: call getSoonestAcrossBarbers. Render: "Next available: Tomorrow 2:30 PM with Rick →" linking to /book?barber=<thatBarberId>.
      d. If no slots are available within 7 days for whoever we picked: render fallback CTA "Find your next time →" linking to /book — warm, no specific time displayed.
    - This availability widget sits prominently in the hero section. Existing hero layout/copy stays intact above it.

13. src/components/home/HeroAvailability.tsx (new, server-rendered)
    - The component that handles the four cases above.
    - Receives: { mode: 'personalized' | 'soonest' | 'fallback', slot?, barber? }
    - Renders the right CTA for each mode.

============================================================
PART D — LIVE CATALOG SYNC (6c)
============================================================

This part replaces hardcoded service/price/duration data on the marketing pages with live data from Square's catalog.

Step 1: Audit what's currently hardcoded.

14. Investigation step (do this first, report findings before continuing):
    - Grep src/pages/services.astro for hardcoded prices, durations, or service names. Report what's there.
    - Grep src/pages/index.astro for the same. Report.
    - Check src/components/ for any service-listing components with hardcoded data.
    - This determines the scope of refactoring. If services.astro is already calling getServices(), 6c is mostly a no-op and we just verify. If it's hardcoded, we refactor.

Step 2: If services.astro (or any other page) has hardcoded service data, refactor:

15. src/pages/services.astro (modify if needed)
    - At server-side: call getServices() (Phase 1).
    - Render service cards from the live data.
    - Hide VIC (already done in getServices, but verify).
    - For variable-pricing services (Haircut + Design, NEW CUSTOMERS), display "Starting at $30" or similar — don't display "Variable" raw.
    - For per-barber variations (Men's Haircut, Haircut & Beard), show one card with the price (they're all the same, $30 or $45 respectively) — don't show three separate cards for the same service.
    - Keep the page prerendered (export const prerender = true) — service data only changes when Michael edits the catalog, which is rare. We'll trigger rebuilds via cron (next step).

16. src/pages/index.astro (modify if a homepage service section has hardcoded data)
    - Same treatment.

Step 3: Daily auto-rebuild via Vercel Cron.

17. src/pages/api/cron/rebuild.ts (new)
    - Vercel Cron endpoint. Triggered daily at 4 AM ET (which is 9 AM UTC during EDT, 8 AM UTC during EST).
    - Authenticated via Vercel's CRON_SECRET environment variable per https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs. The user will add CRON_SECRET to Vercel env. If missing, return 503.
    - Body: triggers a Vercel deploy hook OR returns success and relies on a Vercel deploy hook configured separately.
    - Recommended approach: the cron endpoint POSTs to Vercel's deploy hook URL stored in env as VERCEL_DEPLOY_HOOK_URL. The user creates the deploy hook in Vercel project settings, copies the URL, and adds it as an env var.
    - Logs the rebuild trigger so we can audit it via Vercel logs.
    - Returns { ok: true, triggeredAt: <timestamp> }.

18. vercel.json (modify or create)
    - Add cron config:
      {
        "crons": [
          {
            "path": "/api/cron/rebuild",
            "schedule": "0 9 * * *"  // 9 AM UTC = 4-5 AM ET depending on DST
          }
        ]
      }
    - Note in the README that this assumes EDT (summer). During EST (winter), the rebuild fires at 5 AM ET. That's still within shop downtime (closes at 6 PM, opens at 9 AM).
    - Alternative: schedule for 8 AM UTC (3-4 AM ET) to be safer in both time zones.

19. README.md (modify)
    - Document the catalog-sync flow: "Services page reads from Square catalog at build time. A daily Vercel cron at 4 AM ET triggers a rebuild via deploy hook so Michael's catalog edits propagate within 24 hours. Required env vars: CRON_SECRET, VERCEL_DEPLOY_HOOK_URL. Deploy hook is configured in Vercel project settings → Git → Deploy Hooks."

============================================================
PART E — WIRING + POLISH
============================================================

20. src/lib/booking/wizardPreselect.ts (new utility)
    - Parses URL params on /book: ?service=<id>, ?barber=<id>, ?reschedule=<id>.
    - Returns { serviceVariationId?, teamMemberId?, rescheduleBookingId? } that BookingWizard uses to preselect.
    - Reschedule mode (Phase 5) already exists; this just unifies the URL-param-to-state plumbing.

21. src/components/booking/BookingWizard.tsx (modify, from Phases 2 + 5)
    - Read the preselect data on mount via wizardPreselect.
    - If serviceVariationId is set, skip Step 1 and start at Step 2 (or Step 3 if barber is also set).
    - If barber is set without service, start at Step 1 with that barber pinned across whichever variations support them.
    - Don't break existing reschedule-mode logic; add this on top.

22. CSS / styling
    - "Next available" line uses a green dot indicator (small CSS circle, ~8px, accent green from the design tokens).
    - RebookUsualCard and NewCustomerCard match the existing my-bookings page aesthetic.
    - Hero availability widget in the homepage feels prominent without screaming — use the existing accent-color CTA style, just put the live time data in front of the user.
    - All new components mobile-first, tested at 375px.

============================================================
CONSTRAINTS (hard rules)
============================================================

- Cache TTL is 10 minutes for next-available data. Don't use shorter (Square API costs) or longer (stale data shows up to customers).
- "Within 7 days" threshold is consistent across all features — if a slot isn't within 7 days, it doesn't render as a specific time. Same threshold everywhere.
- shouldShowRebookCard is the single source of truth for the rebook card. Don't duplicate the logic in components.
- Catalog rebuild is daily at 4 AM ET (or close to it given UTC scheduling). Not hourly — that's overkill and burns build minutes.
- Auth-aware homepage: only personalize for signed-in customers. Guest visitors get soonest-across-barbers. Same threshold rules.
- No new heavy dependencies. Native fetch, native crypto, native Intl. The cache is a plain Map.
- Strict TypeScript, no `any`. All Square calls go through Phase 1 wrappers.
- Token leak check still applies: grep dist/ for EAAA, RESEND, AUTH_SECRET, CRON_SECRET — must be zero hits.
- Quick-rebook endpoint validates the slot is still available before creating the booking. If a customer's "Friday 2pm" was just taken, return 409 SLOT_TAKEN with a helpful message.
- The barber-loyalty rule (Phase 6a): don't push customers to other barbers. If their usual barber is booked >7 days out, show "Rick's first opening is [date]" with a clear "See other barbers" option, but don't auto-suggest someone else.
- The catalog page must continue to render even if Square is down — wrap getServices() in a try/catch and fall back to the last-known-good data (cached at build time as a fallback JSON). Better to show stale prices than a broken page.

============================================================
WHEN YOU FINISH
============================================================

Test plan (run end-to-end against production):

1. Run `npm run build`. Zero errors.
2. Token-leak greps return zero hits.
3. Part A — cache:
   - Visit /api/square/health twice in quick succession; second response should be observably faster (cache warmth). Add a debug log if needed to confirm.
4. Part B — rebook your usual:
   - Sign in as bilsonxnc@gmail.com (existing customer with past bookings).
   - Verify the rebook card appears IF: they have past bookings AND no upcoming booking. (If they have an upcoming booking from earlier testing, cancel it first to verify the card shows correctly.)
   - Verify the card shows the right service+barber based on their history.
   - Verify 3 quick slots render and are within 7 days.
   - Click a slot, confirm the modal, complete the booking. Verify it appears in Square.
   - Cancel that test booking from Square dashboard.
   - Verify the card reappears after cancellation (no upcoming booking now).
   - Test new-customer fallback: sign in as a fresh customer with zero bookings (or simulate by temporarily filtering out the bookings). Verify NewCustomerCard appears instead.
5. Part C — live availability:
   - Visit /barbers as a guest. Each barber card should show "Next available: [time]" if a slot exists within 7 days.
   - If a barber is booked solid for 7+ days, their card should NOT show the availability line.
   - Visit / (homepage) as a guest. Hero shows "Next available: [time] with [Barber]".
   - Sign in. Visit / again. Hero now shows YOUR usual barber's next opening (assuming you have a usual).
   - Sign out. Visit /. Back to soonest-across-barbers.
6. Part D — catalog sync:
   - Report findings from the audit step (was services.astro hardcoded? was anything else?).
   - If refactored: verify /services renders correctly with live catalog data and matches the prior visual layout.
   - Verify the cron endpoint is reachable: curl -X POST https://<prod>/api/cron/rebuild with the CRON_SECRET header → should return 200 and trigger the deploy hook.
   - Verify in Vercel that a new deployment kicks off when the cron fires (or simulate by hitting the cron endpoint manually).
   - Verify vercel.json has the cron config.
7. Part E — wiring:
   - Click a "Book with Rick" button on /barbers — should land on /book with Rick preselected.
   - Click "See all times" on the rebook card — should land on /book with service AND barber preselected.
8. Lighthouse audit on /barbers and / — both must stay ≥ 90 / 95 / 95 / 95 after the SSR switch.
9. Cleanup: cancel any test bookings.
10. Report findings step by step. List files created/modified. Flag any deviations or unclear edge cases.
```

---

## Definition of done

- [ ] `RESEND_API_KEY`, `AUTH_SECRET`, `CRON_SECRET`, `VERCEL_DEPLOY_HOOK_URL` all set on Vercel and locally
- [ ] Vercel deploy hook configured in project settings
- [ ] Phase 6a: Rebook card appears for returning customers with no upcoming booking
- [ ] Phase 6a: 3 quick slots render and one-tap booking works end-to-end
- [ ] Phase 6a: New-customer fallback card renders for first-timers
- [ ] Phase 6b: Barber cards on /barbers show next available within 7 days
- [ ] Phase 6b: Homepage hero shows soonest-across-barbers for guests
- [ ] Phase 6b: Homepage hero shows usual-barber's-next for signed-in customers
- [ ] Phase 6c: Catalog audit complete; refactor done if needed
- [ ] Phase 6c: Daily cron at 4 AM ET triggers a rebuild via deploy hook
- [ ] Lighthouse mobile scores hold ≥ 90 / 95 / 95 / 95 on `/`, `/barbers`, `/services`, `/my-bookings`
- [ ] No tokens or secrets in client bundle
- [ ] All test bookings cleaned up

When all are true, Modern Classic has a fully live, real-time booking site that feels custom-built per customer.
