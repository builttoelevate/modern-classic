# Phase 4 — Polish, Edge Cases & Production Readiness

**Goal:** Take the working booking system from Phase 3 and harden it for real customers. After this phase, the wizard handles every realistic edge case gracefully, looks polished on every device, and is something you'd be proud to point Michael's customers at.

**Prerequisites:**
- Phases 1–3 are done. Real bookings work end-to-end.
- A few real test bookings have been completed and deleted.
- Michael has reviewed the wizard at least once and given feedback.

**Out of scope:** TintShopLaunch features, multi-tenant logic, anything not directly serving Modern Classic customers.

---

## Paste this prompt into Claude Code

```
Read SQUARE_REFERENCE.md and the three previous phase docs (PHASE_1_API_WRAPPER.md, PHASE_2_BOOKING_WIZARD.md, PHASE_3_BOOKING_WRITES.md) before doing anything else.

Your task is Phase 4: polish the booking system for production. Group the work into the four areas below. For each item, decide whether it's worth doing now — if it's not, mark it as deferred and explain why in the final report. Default to shipping the higher-value items.

A. EDGE CASES (must-have)

1. Empty availability: when /api/square/availability returns zero slots for the entire 14-day window, render a friendly screen ("No openings in the next two weeks — call us at 740-297-4462") instead of an empty grid.

2. Concurrent booking collision: when Phase 3's create returns "slot taken," return the user to Step 3 with the bad slot pre-disabled and a toast explaining what happened. Do not lose their service/barber selection.

3. Lead-time too short: Square rejects bookings that violate Michael's minimum lead time. Surface the error as "Sorry, that's too soon — please pick a later time" and re-prompt.

4. Variable-pricing services on Step 5: clarify in the UI that the displayed range ($30–$45) is finalized in person. Add a single line: "Final price set at the appointment."

5. Returning customer: if findOrCreateCustomer returns an existing record, do NOT silently overwrite their phone or name with form input that differs. If form input differs from existing record, show a small note on Step 5 ("We have a different phone number on file — should we update it?") with a checkbox. Default unchecked.

6. Network failure mid-booking: if the POST /api/square/bookings request times out or the connection drops, the user must see a "We're not sure if your booking went through — please check your email or call the shop" message. Do not auto-retry. The deterministic idempotency key from Phase 3 protects against duplicates if they retry manually.

7. Closed-day handling: Sundays are already excluded. Also exclude any day where Michael's business hours in /v2/locations show CLOSED, in case he closes for a holiday. Pull live business hours at request time, not from the cached build-time copy.

B. CALENDAR & MESSAGING (high-value polish)

1. .ics calendar attachment on the confirmation email. RFC 5545 format, single VEVENT, includes location address, organizer (the shop), attendee (the customer), 24-hour reminder. Generate it server-side and attach via Resend's attachments field.

2. SMS confirmation via Twilio (optional — only if Bill has Twilio credentials ready). Send a short SMS at booking time and a 24-hour-before reminder. Reminder uses a Vercel cron job that queries upcoming bookings via /v2/bookings, filters to bookings starting in 23–25 hours, and sends one reminder per booking. Track sent reminders to prevent doubles (a JSON file on disk is fine for now; KV later).

3. Customer-facing booking lookup: a /booking/[id] page where someone can paste their booking id (from the email) and see appointment details + a "request cancellation" button that emails the shop. No actual cancel API call — that requires extra scopes and confirmation flow.

C. UX POLISH (worth a half-day)

1. Loading skeletons on Step 3 instead of "Loading..." text.
2. Smooth step transitions (CSS opacity/translate, 200ms).
3. Keyboard navigation: full tab order, Enter advances to next step when valid, Escape cancels back to previous.
4. Form persistence: write wizard state to sessionStorage on every change; restore on reload. Clear after successful booking.
5. Visible "Step X of 5" + estimated time remaining ("About 1 minute").
6. Mobile haptic feedback on iOS Safari for selection events (navigator.vibrate where supported).
7. Better empty state on the date picker: when a chosen date has no slots, suggest the next 2–3 dates that DO have slots.
8. Confirmation page CTAs: "Add to Google Calendar" (working URL), "Add to Apple Calendar" (.ics download), "Get directions" (Google Maps), "Save shop number" (vCard download or tel: link).

D. OBSERVABILITY (essential before going live)

1. Server-side logging at every step of /api/square/bookings: which step succeeded, which failed, with structured JSON output to the Vercel function logs. Redact emails to first-letter+domain (a***@gmail.com), redact phone numbers entirely.

2. Error tracking: integrate Sentry or a similar service. Capture every SquareApiError, every email failure, every uncaught exception in /api/square/* endpoints. Tag with phase ("booking-create", "availability-search", etc.).

3. A simple admin dashboard at /admin/bookings (password-protected via Basic Auth using ADMIN_PASSWORD env var) showing the last 50 booking attempts with status, timestamp, customer initials, service, slot. Pulls from a JSON log file or directly from /v2/bookings — your choice.

4. Health check endpoint enhancements: /api/square/health should also verify SCOPED writes work by attempting a /v2/customers/search with a known-bad email and confirming the response shape, not the data. Catches scope misconfigurations before they break booking.

Constraints:
- No new heavy dependencies. If you reach for a date library, calendar library, or tracking SDK, pause and confirm. Native APIs and small functions first.
- Every new feature must degrade gracefully. If Twilio is not configured, the SMS path is silently skipped, not crashed.
- Performance: Lighthouse mobile score on /book should stay 90+ for performance and accessibility. Run `lighthouse https://localhost:4321/book --view` (or Vercel preview URL) before declaring done.
- No regressions: every Phase 1–3 test that passed before must still pass.

When you finish:
1. Run `npm run build` and ensure zero errors.
2. Run a Lighthouse audit on /book and paste the four scores (Performance / Accessibility / Best Practices / SEO).
3. Walk through every edge case in Section A and report observed behavior.
4. List every file created or modified and any deferred items with rationale.
5. Provide a one-paragraph "ready for launch?" verdict.
```

---

## Definition of done

- [ ] All seven edge cases in Section A are handled with appropriate UI.
- [ ] `.ics` attachment arrives in the confirmation email and adds the event correctly to Google Calendar, Apple Calendar, and Outlook.
- [ ] Lighthouse mobile scores: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95 on `/book`.
- [ ] Logs from a real booking show the redacted-email, redacted-phone format.
- [ ] `/admin/bookings` is reachable with the admin password and shows recent activity.
- [ ] No regressions in Phases 1–3 functionality.
- [ ] Bill has personally walked through the flow on his phone (375px) and a desktop browser.
- [ ] Michael has personally walked through the flow and approves it for live customers.

When all of the above is true, the booking system is production-ready. Hand it to Michael, deploy to the live domain, and watch the first real booking come through.
