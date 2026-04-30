# Phase 3 — Booking Writes & Email Confirmation

**Goal:** Replace the Phase 2 stub with a real booking implementation. After this phase, clicking "Confirm" on the wizard creates a real customer (or finds an existing one), creates a real Square booking, and sends a confirmation email. The appointment appears in Michael's Square dashboard and on the customer's calendar.

**Prerequisites:**
- Phase 1 and 2 are done. The wizard works end-to-end with the stub.
- `SQUARE_ACCESS_TOKEN` has `APPOINTMENTS_WRITE` and `CUSTOMERS_WRITE` scopes (verify with Michael before starting — see `SQUARE_REFERENCE.md` section 1).
- Decide email sender: Resend is already in use elsewhere at `tintshoplaunch.com`. We'll send from `bookings@modernclassicbarbershop.com` once the domain is verified, or from a Resend test address until then. Confirm with Bill before coding.

**Out of scope for this phase:** SMS confirmations (Twilio), calendar `.ics` attachments, reminder emails 24h before appointment. Those are Phase 4 polish.

---

## Paste this prompt into Claude Code

```
Read SQUARE_REFERENCE.md, PHASE_1_API_WRAPPER.md, and PHASE_2_BOOKING_WIZARD.md before doing anything else.

Your task is Phase 3: replace the stub at /api/square/bookings with a real implementation that creates customers and bookings in Square, then sends a confirmation email via Resend.

Build or modify these files:

1. src/lib/square/customers.ts (new)
   - `findCustomerByEmail(email): Promise<Customer | null>` — POST /v2/customers/search with { query: { filter: { email_address: { exact: email } } } }. Return the first match or null.
   - `createCustomer({ givenName, familyName, email, phone }): Promise<Customer>` — POST /v2/customers.
   - `findOrCreateCustomer(info): Promise<Customer>` — combines the two; if found, optionally PATCH to update phone/name if they differ; if not, create. Idempotent on email.
   - Add Customer to src/lib/square/types.ts with id, givenName, familyName, emailAddress, phoneNumber.

2. src/lib/square/bookings.ts (new)
   - `createBooking({ startAtUtc, customerId, serviceVariationId, serviceVariationVersion, teamMemberId, durationMinutes, customerNote, idempotencyKey }): Promise<Booking>` — POST /v2/bookings with the shape from SQUARE_REFERENCE.md section 5.
   - Throws SquareApiError on failure. Returns the created booking including Square's booking id.
   - Add Booking type to types.ts with id, version, status, startAt, locationId, customerId, appointmentSegments.

3. src/lib/email/resend.ts (new)
   - Wrapper around Resend's HTTP API (don't pull in the SDK — same minimalism as Square wrapper). Read RESEND_API_KEY from env.
   - `sendBookingConfirmation({ to, customerName, serviceName, barberName, startAtLocal, durationMinutes, priceDisplay, locationAddress, customerNote }): Promise<{ id: string }>`.
   - Inline HTML email with the brand styling — clean, masculine, dark neutrals with a warm accent. Plain-text fallback included.
   - Email content: greeting by first name, appointment summary, address with a Google Maps link, cancellation policy (24-hour notice, no-show charge), shop phone for changes, "Add to calendar" — for now, link to a Google Calendar prefilled URL (the .ics file is Phase 4).

4. src/lib/email/templates.ts (new)
   - One exported function `bookingConfirmationHtml(props)` returning the HTML string. Plain string concatenation is fine — no JSX-on-server, no MJML, keep it simple. Inline CSS for email-client compatibility.
   - One `bookingConfirmationText(props)` for the plaintext alternative.

5. src/pages/api/square/bookings.ts (REPLACE the stub)
   - POST endpoint accepting the wizard's payload: { service: { variationId, version, durationMinutes, name, priceDisplay }, barber: { id, name }, slot: { startAtUtc }, customer: { givenName, familyName, email, phone, note } }.
   - Validate all required fields; return 400 with a structured error on bad input.
   - Generate idempotencyKey from a hash of (email + startAtUtc + variationId) so a double-click produces the same key and Square dedupes.
   - Steps in order:
     a. findOrCreateCustomer
     b. createBooking
     c. sendBookingConfirmation (do not block on email failure — log it, return success to the user, surface in monitoring later)
   - Return { ok: true, bookingId, customerId }.
   - On Square error, return { ok: false, error: { code, detail } } with a 4xx or 5xx as appropriate. Do NOT leak the access token or full API response.

6. src/components/booking/Step5Confirm.tsx (modify)
   - Keep the existing UI; just point at the now-real endpoint.
   - On success, the confirmation screen should show the real booking id and confirmation email destination ("We've sent a confirmation to alex@example.com").
   - On failure, surface a human-readable message based on the error code: AUTHENTICATION_ERROR → "Booking system temporarily unavailable, please call the shop"; INVALID_TIME → "That slot was just taken, please pick another"; default → generic retry message.

7. .env.example (modify or create)
   - Add RESEND_API_KEY=... with a comment.

8. README.md (modify)
   - Add a "Booking system" section describing env vars required and the phase docs to read before changes.

Constraints:
- Idempotency: same payload submitted twice within 60 seconds must NOT create two bookings. The deterministic idempotency key handles this on Square's side.
- Concurrency: if two customers try to book the same slot simultaneously, the second one will get an error from Square. Surface it as "That slot was just taken" — do not crash.
- Retries: do NOT auto-retry on 5xx. Return the error and let the user retry. Auto-retries with the same idempotency key are safe but add complexity we don't need yet.
- Logging: log every booking attempt server-side with timestamp, customer email, service, slot. Redact phone numbers in logs. No PII in error responses to the client beyond what they already submitted.
- Email is best-effort. A failed email must NOT roll back the booking. Square is the source of truth.
- Test against production Square. If a sandbox is available and configured, prefer it for the first end-to-end run; otherwise use a real test booking with Michael's blessing and delete it afterward.

When you finish:
1. Run `npm run build` and fix all type errors.
2. Walk the full flow on the dev server with a real test booking. Capture the booking id, verify it appears via curl GET /v2/bookings on the location.
3. Confirm the email was received (check the recipient inbox or Resend dashboard).
4. Manually cancel the test booking from Michael's Square dashboard so it doesn't sit there.
5. Report each step's outcome and list every file touched.
```

---

## Definition of done

- [ ] A real test booking appears in `GET /v2/bookings?location_id=523GMGEC1FY0Z`.
- [ ] The customer record exists in Square's customers list with correct email and phone.
- [ ] The confirmation email arrived with a working Google Maps link and the cancellation policy.
- [ ] Submitting the same payload twice within 60s creates exactly one booking.
- [ ] A deliberately invalid payload returns a 400 with a clear error and never reaches Square.
- [ ] No `EAAA` token leaks anywhere in client bundles or logs.
- [ ] Test booking deleted from Michael's dashboard after verification.

When all of the above is true, Phase 3 is done. Move to Phase 4.
