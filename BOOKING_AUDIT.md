# Booking, Admin & Square API Audit — Improvements List

## Context

This is an audit-style plan (not an implementation spec). The site has shipped through Phase 7 (live availability, rebook-your-usual, marketing consent, automated review requests). Recent fixes addressed acute customer-blocking issues (phone-or-email sign-in, OG image, "Cuts from $15", First Visit deep-link). With those fires out, the question is: what else is worth doing across the booking flow, the admin surface, and our Square API leverage — staying within the existing **free Square API surface + Resend** (no Twilio, no Square Payments, no paid Square add-ons like Loyalty).

Each item below is graded by **effort (S / M / L)** and **impact (low / med / high)**. Pick the lines you want to act on; we'll spec each one separately when it's time to ship.

---

## 1. Booking Flow — Customer-Facing

### High priority

- **Hard-fail loud when Square catalog/team/location load fails** _(S, high)_
  Today `book.astro:39-48` swallows the error into `loadError` but still mounts the wizard with empty arrays. Customer sees a hung wizard. Render the error state instead of mounting the wizard at all.
  Files: `src/pages/book.astro`

- **Step 3 calendar: visible error state on month-fetch failure** _(S, high)_
  `Step3DateTimePicker.tsx:362-374` only shows error when `monthState.status === 'error'`, but if a previously-loaded month is then re-fetched and fails, the spinner just stops. Add an explicit error banner with a "Try again" action.
  Files: `src/components/booking/Step3DateTimePicker.tsx`

- **Stale reschedule URL guard** _(S, high)_
  `book.astro` validates the booking exists, but a customer could bookmark `/book?reschedule=X` and return after the booking was already cancelled or completed. Today they get a confusing "doesn't belong to your account" message. Check the booking's status before mounting the wizard and show a tailored message.
  Files: `src/pages/book.astro:50-119`

- **Debounce Step 5 customer-conflict lookup** _(S, medium)_
  `Step5Confirm.tsx` re-fetches `findCustomerByEmail` on every keystroke when the user edits email/phone/name on Step 4 (since those flow through). Debounce to ~400ms. Currently fine for one user but burns API quota on every booking.
  Files: `src/components/booking/Step5Confirm.tsx`

### Medium priority

- **"Slot taken" doesn't reset the wizard** _(S, medium)_
  Today the toast appears and the slot is added to `blockedSlots`, but the user is still on Step 5. They have to manually click Back to Step 3 to pick another. Auto-route them back with a contextual toast.
  Files: `src/components/booking/BookingWizard.tsx:340-370`

- **localStorage draft-save for Step 1-2 selections** _(M, medium)_
  Closing the tab on Step 2 loses everything. Persist `selectedService`, `selectedBarber`, `anyBarber` to localStorage with a 2-hour TTL; restore on load if the URL is bare.
  Files: `src/components/booking/BookingWizard.tsx`, new `src/lib/booking/draftStore.ts`

- **Inline note field on Step 5 (signed-in users skip Step 4)** _(S, medium)_
  When the wizard auto-skips Step 4, the optional barber-note field is also skipped. Add a collapsible "+ Add a note for your barber" expand on Step 5 above the Confirm button.
  Files: `src/components/booking/Step5Confirm.tsx`

- **Better empty state when a barber has zero slots in 14 days on Step 2** _(S, medium)_
  Currently their card just shows nothing. Show "Booked solid — see [other barber name]" or "Booked through [date] — view all times →" linking to Step 3 with extended search.
  Files: `src/components/booking/Step2BarberPicker.tsx`

- **"Go to next available" should auto-pick the slot, not just the date** _(S, medium)_
  Today it jumps to the right month and selects the day, then waits for the user to tap a time. One extra tap on a flow that already had friction.
  Files: `src/components/booking/Step3DateTimePicker.tsx`

- **Service tile copy + photos on Step 1** _(M, medium)_
  Text-only grid at small sizes; service distinctions blur. Add a small thumbnail per service slug (re-use existing brand artwork for haircut/beard/shave/style).
  Files: `src/components/booking/Step1ServicePicker.tsx`, new images in `public/services/`

- **Barber crest → real headshot on Step 2** _(M, medium)_
  Initials are functional but generic. Same artwork pattern already TODO'd in `pages/barbers.astro:143`.
  Files: `src/components/booking/Step2BarberPicker.tsx`, `src/pages/barbers.astro`

### Low priority

- **Calendar keyboard navigation (arrow keys move between days)** _(S, low)_
  `Step3DateTimePicker` has `role="grid"` but no keydown handlers. Adds polish + a11y.

- **Cross-sell on Step 3 ("Add a beard trim while you're here?")** _(M, low)_
  Show after time-pick but before Confirm. Risk of friction if too pushy.

- **International phone support** _(S, low)_
  `wizardState.ts:digits()` requires exactly 10 digits. Trivial fix if anyone ever asks.

---

## 2. Customer Portal & Sign-in

### High priority

- **Resend the magic link from the success state** _(S, high)_
  Today the success card just says "check your email" — no resend. If the email goes to spam and they delete it, the only path is starting over. Add a "Resend link" button that hits `/api/auth/request` again with the same identifier and shows a small countdown.
  Files: `src/pages/sign-in.astro`

- **Per-card "Rebook this" button on past bookings is missing context-aware copy** _(S, low — already mostly done)_
  Already shipped via "Book again". Verified working. Skip unless something breaks.

### Medium priority

- **Show the magic-link sender name + an example domain in the form copy** _(S, medium)_
  Sign-in card already mentions `bookings@designedtoelevate.co` in the success state — also surface it in the form's helper text so customers can pre-whitelist or know what to look for.
  Files: `src/pages/sign-in.astro`

- **My-bookings: filter past bookings by year** _(S, low)_
  With 26 past bookings already in the screenshot, the list will keep growing. Add year tabs or a search box.
  Files: `src/components/bookings/MyBookingsList.tsx`

- **My-bookings: show a customer-facing booking reference in BookingCard** _(S, medium)_
  Today the booking ID is hidden. Surfacing a short ref lets customers quote it on the phone if they call to change something.
  Files: `src/components/bookings/BookingCard.tsx`

### Low priority

- **Sign-in flow: SSR fallback for the success state** _(M, low)_
  Currently relies on inline JS. If JS fails, the form submits and you land on a JSON response. Low priority because every modern browser runs the JS path.

---

## 3. Admin Page (`/admin`)

The admin surface today is read-only: bookings list (last 50, no filters) + review-request stats. Auth is solid (HTTP Basic, timing-safe). Below are the features that would replace Michael's "go to Square's app" trips.

> **Update (May 2026):** Today's queue (`/admin/today`) and Customer search/edit (`/admin/customers`) **shipped** in commit `b027e86`. The remaining items below are still open.

### High priority

- ~~**Today's queue view (`/admin/today`)** _(M, high)_~~ ✅ shipped
  List of today's bookings (and tomorrow's at a glance), sorted by time, with customer name, phone, service, barber, and any customer note. One screen Michael loads first thing in the morning. No mutations needed in v1.
  Files: new `src/pages/admin/today.astro`, reuses `listBookings` + `getBarbers` + `getServices`

- ~~**Customer search + edit email/phone (`/admin/customers`)** _(M, high)_~~ ✅ shipped
  This is the single thing that fixes "phone-only customers can't sign in" — Michael searches a customer, types in their email, and we update Square via `updateCustomer`. Today he has to do this in Square's app, which is friction enough that he doesn't.
  Files: new `src/pages/admin/customers.astro`, new `src/pages/api/admin/update-customer.ts`, reuses `findCustomerByEmail` / `findCustomerByPhone` / `updateCustomer` from `src/lib/square/customers.ts`

- **Waitlist inbox view (`/admin/waitlist`)** _(M, high)_
  Today every waitlist submission emails the shop. After 10 of them his inbox is buried. Persist them server-side (KV-backed since Phase 7 already brought in `@upstash/redis`) and render the last 50 in admin with status (new / contacted / booked / archived) and a "mark contacted" toggle.
  Files: new `src/lib/marketing/waitlistLog.ts`, modify `src/pages/api/waitlist.ts` to also write to KV, new `src/pages/admin/waitlist.astro`

### Medium priority

- **Inline reschedule/cancel on the bookings table** _(M, medium)_
  We already have the `/api/square/bookings/[id]/cancel` endpoint and a reschedule flow. Mirror them as admin actions so Michael doesn't have to switch to Square for a simple swap.
  Files: `src/pages/admin/bookings.astro`, `src/pages/api/admin/cancel-booking.ts` (new wrapper that doesn't require customer-id ownership match)

- **Filter the bookings list by date range + barber** _(S, medium)_
  Currently last-50-only. Add `?from=YYYY-MM-DD&to=YYYY-MM-DD&barber=...` query params and matching form on the page.
  Files: `src/pages/admin/bookings.astro`

- **Light-touch shop dashboard** _(M, medium)_
  Bookings this week vs last week, no-show count, top service, top time slot. All derived from `listBookings` + customer attrs already in KV. No paid analytics tools.
  Files: new `src/pages/admin/dashboard.astro`, new `src/lib/admin/stats.ts`

- **Block out time / day off** _(M, medium)_
  Square doesn't expose a "blackout" API directly, but we can create a synthetic booking on the shop's behalf via `POST /v2/bookings` with a special service marked "shop closed". Or simpler: a UI that tells Michael to set it in Square and links straight there. The simpler path is fine for v1.
  Files: new `src/pages/admin/blocks.astro` (deep-links to Square dashboard)

### Low priority

- **CSV export of customer list** _(S, low)_
  Useful once for migration / backup. New endpoint streams CSV from `/v2/customers/list`.

- **Send a one-off reminder email to a specific upcoming booking** _(M, low)_
  Pre-populated form on the booking row; reuses Resend.

---

## 4. Square API Leverage — Free-Tier Wins

### High priority

- **Square webhooks: `booking.updated` + `booking.canceled`** _(M, high)_
  Right now if Michael cancels a booking inside Square's seller dashboard, our review-request automation, customer-portal cache, and any future SMS path don't know. Subscribe to the bookings webhook so changes reflect immediately. Delivery target: a new `/api/webhooks/square` endpoint that updates KV / busts caches.
  Files: new `src/pages/api/webhooks/square.ts`, signature verification helper in `src/lib/square/webhooks.ts`

- **24-hour-before reminder emails (Resend cron)** _(M, high)_
  Phase 7 already has the cron infrastructure (`vercel.json` crons + `REVIEW_CRON_SECRET` pattern). Add a parallel job that runs every 30 minutes, finds bookings starting in [23h, 23.5h], and emails a reminder. Same anti-double-send pattern (KV log keyed by booking id). Material reduction in no-shows for zero new cost.
  Files: new `src/pages/api/cron/reminders.ts`, new `src/lib/email/templates/reminder.ts`, KV log helper

- **Live business hours from `GET /v2/locations`** _(S, medium)_
  Hardcoded in `SQUARE_REFERENCE.md` and again in `Step3DateTimePicker.tsx:114-119`. Means a holiday close has to be coded in two places. Fetch at build time, bake into a constant.
  Files: `src/lib/square/locations.ts` (already exposes location), `src/components/booking/Step3DateTimePicker.tsx`

### Medium priority

- **Booking custom attributes for internal notes** _(S, medium)_
  Phase 7 already wired up customer custom attributes; same pattern works for bookings. Lets the admin "today queue" surface internal notes Michael adds (e.g., "first-timer", "always runs late") without polluting the customer-visible note field.
  Files: new `src/lib/square/bookingAttributes.ts`

- **Inventory sync for shop products** _(M, medium)_
  Today `getRetailProducts()` in `src/lib/square/catalog.ts` shows everything. Square's Inventory API can tell us when something's out of stock — useful once retail volume picks up.
  Files: extend `src/lib/square/catalog.ts`, modify `src/components/ShopEssentials.astro` and `src/pages/shop.astro`

- **Catalog: stop hardcoding hidden item IDs** _(S, low)_
  `HIDDEN_ITEM_IDS` lives in two files (`Step1ServicePicker.tsx:11`, `src/lib/square/catalog.ts:11`). Fold into a single export and reference it everywhere.

### Low priority

- **Discounts / promo codes** _(M, low)_
  Square has a Discounts API. Adds a "promo code" field to Step 5. Probably not worth shipping until Michael actually wants to run a promo.

- **Square refunds API integration** _(M, low)_
  Only matters if we ever take payment online. Out of scope per "no Square Payments".

---

## 5. Data Hygiene & Code Quality

These are not user-visible but reduce future bugs.

- **Unify `HIDDEN_ITEM_IDS` and slug allowlists into one config module.** _(S, low)_
- **Replace in-memory rate-limit Maps in `/api/auth/request` and `/api/waitlist` with KV-backed counters** so they survive Vercel cold starts. _(S, medium)_
- **Race-condition guard around `Step5Confirm` submit** — disable the Confirm button (already done) but also early-return in the submit handler if `state.status.kind === 'submitting'`. _(XS, low)_
- **`Step3DateTimePicker.mergeSlots` shows only the first matched team member** when "Any barber" returns multiple parallel free slots; downstream the user can't see the count. Surface it as a tooltip. _(S, low)_

---

## 6. Recommended sequencing — start here

If you want a 5–7 item cut to actually ship over the next few weeks, in order:

1. ~~**Customer search + edit email/phone in admin**~~ ✅ shipped — unblocks every phone-only customer from signing in. Single biggest user-facing fix. _(M, high)_
2. ~~**Today's queue view in admin**~~ ✅ shipped — biggest daily-use win for Michael. _(M, high)_
3. **24-hour reminder emails via Resend cron** — cuts no-shows for free. _(M, high)_
4. **Hard-fail loud when book.astro can't load Square** + **Step 3 month-fetch error state** — kills the worst silent-fail scenarios. _(S each)_
5. **Square webhooks for booking updates** — foundation for any real-time admin features. _(M, high)_
6. **Resend magic link from the sign-in success state** — small fix, big "did the email arrive?" ergonomics. _(S)_
7. **Waitlist inbox view in admin** — protects Michael's email from being the only system of record. _(M)_

Items 1–3 alone would noticeably move customer-experience metrics. 4–7 are quality-of-life that compounds.

---

## Verification approach (per item, when we ship)

- Each booking-flow change: walk the wizard end-to-end at least twice (signed-in + guest), at desktop + mobile widths, with a deliberate Square API failure injected (block the network for one fetch in DevTools) to verify error states.
- Each admin change: log in via Basic Auth, exercise the new screen, then verify nothing-changed in the seller-side Square dashboard (we don't want the admin to silently mutate things Michael will later find surprising).
- Each Square API addition: dry-run mode flag (`?dryRun=1`) following the same pattern Phase 7 uses for `/api/cron/review-requests`. Log what would have happened, ship, then drop the flag.
- Cron jobs: deploy with the cron disabled in `vercel.json`, hit the endpoint manually with the secret, verify behavior, then enable.

---

## Critical files referenced

- `src/pages/book.astro`
- `src/pages/sign-in.astro` + `src/pages/api/auth/request.ts`
- `src/components/booking/BookingWizard.tsx` + `wizardState.ts`
- `src/components/booking/Step1ServicePicker.tsx` … `Step5Confirm.tsx`
- `src/components/bookings/MyBookingsList.tsx` + `BookingCard.tsx` + `RebookUsualCard.tsx`
- `src/pages/admin/index.astro` + `bookings.astro` + `reviews.astro` + `today.astro` + `customers.astro`
- `src/pages/api/admin/update-customer.ts`
- `src/pages/api/cron/rebuild.ts` + `review-requests.ts`
- `src/lib/square/customers.ts` + `bookings.ts` + `catalog.ts` + `team.ts` + `locations.ts` + `availability.ts`
- `src/lib/availability/cache.ts` + `nextAvailable.ts` + `timing.ts`
- `vercel.json`
