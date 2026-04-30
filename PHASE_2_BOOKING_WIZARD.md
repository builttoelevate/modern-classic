# Phase 2 — Booking Wizard UI

**Goal:** Build the 5-step booking flow as a styled, working UI. After this phase, a customer can pick a service → barber → date → time → enter info, and see a confirmation screen — but no booking is actually written to Square yet. That's Phase 3.

**Prerequisites:**
- Phase 1 is done. `/api/square/health` returns the expected shape.
- `SQUARE_REFERENCE.md` is in the project root.
- Read `PHASE_1_API_WRAPPER.md` to see what was built and what's importable from `src/lib/square/`.

**Out of scope for this phase:** Customer find-or-create, booking POST, email/SMS confirmation. The "Confirm" button at the end should call a stubbed endpoint that logs and returns success — Phase 3 wires it up for real.

---

## Paste this prompt into Claude Code

```
Read SQUARE_REFERENCE.md and PHASE_1_API_WRAPPER.md in the project root before doing anything else.

Your task is Phase 2 of the Modern Classic booking system: build the 5-step booking wizard UI. Use the Phase 1 wrappers — do not call Square directly from any component.

Build these files:

1. src/pages/api/square/availability.ts
   - Server endpoint that takes serviceVariationId, teamMemberId (optional), and a date range from query params.
   - Calls searchAvailability() from Phase 1 and returns the slots as JSON.
   - Validates inputs; returns 400 with a clear message on bad input.

2. src/pages/book.astro
   - The booking page route at /book.
   - Server-renders the initial state: fetches getServices() and getBarbers() at request time and passes them as props to the wizard component.
   - Renders the BookingWizard component.

3. src/components/booking/BookingWizard.tsx (React, client:load)
   - Stateful 5-step wizard using useReducer for the booking state machine.
   - State shape: { step, selectedService, selectedBarber, selectedSlot, customerInfo, status }.
   - Renders one step at a time with a progress indicator and back/next buttons.
   - Steps below.

4. src/components/booking/Step1ServicePicker.tsx
   - Renders the 8 services as cards (filter out VIC — Phase 1 already does this, but assert it).
   - Each card shows: name, price (or "Starting at $X" for VARIABLE_PRICING), duration, short description if available.
   - Click → set selectedService and advance.

5. src/components/booking/Step2BarberPicker.tsx
   - Logic: if the selected service has per-barber variations (Men's Haircut, Haircut & Beard), render the barbers whose names match a variation; clicking a barber resolves both selectedBarber AND the matching variation.
   - For services with one shared variation, render every eligible barber from that variation's eligibleTeamMemberIds. Add an "Any available barber" option that submits with no teamMemberId filter.
   - Cards show: barber photo (placeholder gray circle for now — we'll add real photos later), name, role.

6. src/components/booking/Step3DateTimePicker.tsx
   - Two-pane layout: left = next 14 days as clickable date buttons (skip Sundays — closed), right = available time slots for the selected date.
   - On date click, fetch /api/square/availability with selectedService.variation.id, selectedBarber.id (or undefined for "any"), and a startAt/endAt covering that single day in America/New_York → converted to UTC.
   - Render slots as buttons in 30-minute groupings, displayed in local time (e.g., "10:30 AM").
   - Show a friendly empty state when a day has zero availability ("No openings this day — try another").
   - Show a loading state while the fetch is in flight.

7. src/components/booking/Step4CustomerInfo.tsx
   - Form: given name, family name, email, phone (US format with input mask), optional note (textarea, max 500 chars).
   - Inline validation: name required, email format, phone 10 digits. Disable Next until valid.
   - On submit, advance to step 5.

8. src/components/booking/Step5Confirm.tsx
   - Read-only summary of everything chosen: service + price/range, barber, date/time in local tz, customer name/email/phone.
   - Display the cancellation policy verbatim (24-hour notice, no-show charge — pull copy from any service description in the catalog or hardcode the canonical version).
   - "Confirm Booking" button → POST to /api/square/bookings (Phase 3 endpoint, stubbed for now to return { ok: true, bookingId: 'STUB' }).
   - On success, render a confirmation screen with the (stub) booking ID and a "Book another" link back to step 1.
   - On failure, render an error with a "Try again" button that goes back to step 5 with state intact.

9. src/pages/api/square/bookings.ts (STUB for this phase)
   - POST endpoint that accepts the wizard's payload, logs it server-side, and returns { ok: true, bookingId: 'STUB-' + Date.now() }.
   - Phase 3 replaces the body with a real implementation.

Styling requirements:
- Match the existing Astro site's design system (Tailwind classes, spacing scale, typography). If there's no design system yet, use a clean, masculine, slightly-vintage aesthetic that fits a barbershop — dark neutrals, warm accent (amber or oxblood), serif headings, generous whitespace.
- Mobile-first. Test the layout at 375px width — most bookings will be on a phone.
- Buttons have visible focus states for keyboard nav.
- Disabled buttons are visibly disabled (lower opacity, no hover state).

Constraints:
- All Square calls go through Phase 1 wrappers. No raw fetch to connect.squareup.com from any component or endpoint other than Phase 1 modules.
- Token must never be exposed to the client. The wizard fetches /api/square/availability — it does NOT call Square directly.
- React components are typed in TypeScript with no `any`.
- One reducer for wizard state. No useState soup.
- Time zone: every UTC ↔ America/New_York conversion stays consistent with Phase 1's availability.ts. If you find yourself reaching for a date library, stop and ask before adding it.
- Don't take screenshots — you can't. Verify by hitting /book in the dev server and walking the flow yourself; describe the behavior in the final report.

When you finish:
1. Run `npm run build` and fix all type errors.
2. Run the dev server, walk through the entire flow, and report each step's behavior with the data shown.
3. List every file created or modified.
4. Note anything unclear about Phase 3's requirements that you discovered while building this phase.
```

---

## Definition of done

- [ ] `/book` renders and walks all 5 steps end to end with a stub success.
- [ ] Service picker hides VIC.
- [ ] Per-barber variations resolve correctly when picking Michael / Rick / Clayton's haircut.
- [ ] Sundays don't appear in the date picker.
- [ ] Availability slots display in `America/New_York` regardless of the user's browser tz.
- [ ] Form validation blocks Next until all required fields are valid.
- [ ] No Square credentials reach the browser bundle (search the built `dist/` for `EAAA` to be sure — should return zero hits).
- [ ] Mobile layout works at 375px width without horizontal scroll.

When all of the above is true, Phase 2 is done. Move to Phase 3.
