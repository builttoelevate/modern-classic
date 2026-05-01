# Phase 7 — Marketing Consent + Automated Review Request Automation

**Goal:** Build the foundation for all future marketing emails (consent checkbox + Square Custom Attributes for storage), then build the first marketing automation: an automated post-appointment Google review request that fires 2 days after every completed cut. Every customer who agreed to marketing emails and just had a great haircut gets one polite, branded email asking for a Google review. Reviews compound forever. Michael's local search ranking improves over time without him doing anything.

**Prerequisites:**
- Phases 1–6 are done and verified live in production.
- `SQUARE_REFERENCE.md` and the six prior phase docs are in the project root.
- Resend domain `designedtoelevate.co` is verified and sending.
- Modern Classic's Google Business Profile review link is known. (You'll need this from Michael — see "Pre-build setup" below.)

**Out of scope for Phase 7:**
- Smart rebook reminders ("it's about that time" emails) — Phase 8.
- Birthday/anniversary emails — Phase 9.
- "We miss you" reactivation emails — Phase 9.
- Manual campaign tool — Phase 10+.
- HubSpot integration — explicitly removed from roadmap.

---

## Why this phase matters

Reviews are the **single highest-ROI feature** for a local barbershop. Modern Classic shows up in Google Maps when someone in Zanesville searches "barber near me." More reviews + higher average rating = higher ranking + more clicks + more new customers walking in.

Most barbers ask for reviews inconsistently. Some never ask. Michael will ask **every customer, automatically, two days after every cut, forever**, without lifting a finger after this ships.

The math: if Modern Classic does 100 cuts/month and 5% of customers leave a review (typical conversion for a well-timed ask), that's 5 new reviews/month — 60/year. Compounding. Within a year, Modern Classic is dominating Zanesville's barbershop search results.

This is the feature that turns the website from "a nice booking tool" into "a real business asset."

---

## Pre-build setup (DO THESE BEFORE PASTING THE PROMPT)

### 1. Get Modern Classic's Google review link

Michael needs to provide his Google review URL. The format is:

```
https://g.page/r/<unique-id>/review
```

Or:

```
https://search.google.com/local/writereview?placeid=<place-id>
```

How Michael gets it:
1. Open Google Maps on his phone or computer
2. Search for "Modern Classic Barbershop Zanesville"
3. Click on the business listing
4. Click "Reviews"
5. Click "Write a review"
6. Copy the URL from the browser's address bar

That URL is the destination for every review request email. Save it as an environment variable: `GOOGLE_REVIEW_URL`.

### 2. Add three new environment variables

To Vercel AND `.env`:

- `GOOGLE_REVIEW_URL` — the URL from step 1 above
- `UNSUBSCRIBE_SECRET` — generate with `-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })` in PowerShell. Used to sign unsubscribe tokens so they can't be guessed/brute-forced.
- `REVIEW_CRON_SECRET` — same generation pattern. Auth-gate for the daily cron job. Separate from the existing `CRON_SECRET` to allow cron jobs to be triggered/disabled independently.

### 3. Verify physical address is correct

CAN-SPAM requires a valid physical address in every commercial email. We'll use Modern Classic's actual address:

> Modern Classic Barbershop
> 819 Linden Avenue
> Zanesville, OH 43701

This is in `SQUARE_REFERENCE.md` already. The email template will pull from there.

---

## Paste this prompt into Claude Code

```
Read SQUARE_REFERENCE.md and the six prior phase docs (PHASE_1 through PHASE_6) in the project root before doing anything else. Phase 7 builds the marketing email foundation and ships the first marketing automation: post-appointment Google review requests.

Your task is Phase 7: marketing consent infrastructure + automated review request system.

You have full autonomy on implementation details. Hard constraints below are real. Definition of done is at the bottom.

============================================================
CRITICAL CORRECTIONS FROM EARLIER ATTEMPTS (READ FIRST)
============================================================

These mistakes have been documented in this codebase's history. Do NOT repeat them:

1. Square's `email_unsubscribed` field is READ-ONLY from the Customers API. You CANNOT write to it. It tells you whether the customer unsubscribed from Square's own marketing — we respect it (never email someone where it's true), but we never set it ourselves.

2. Use Square Customer Custom Attributes API for our own consent storage. Endpoints:
   - POST /v2/customers/custom-attribute-definitions — create attribute definitions (one-time)
   - GET /v2/customers/custom-attribute-definitions — list existing
   - PUT /v2/customers/{customer_id}/custom-attributes/{key} — set a value
   - GET /v2/customers/{customer_id}/custom-attributes — list customer's values

3. Use Square's Bookings API as the source of truth for "did this person actually get a haircut?" — NOT the Customers API. Filter to status === "ACCEPTED" and start_at < now. Skip CANCELLED_BY_CUSTOMER, CANCELLED_BY_SELLER, NO_SHOW, DECLINED.

4. Customer-initiated cancels via our portal show as CANCELLED_BY_SELLER in Square because our code uses the merchant token. Don't try to interpret CANCELLED_BY_SELLER as "Michael cancelled it" — could be either.

5. NEVER do "review gating" (sending happy customers to Google but routing unhappy customers to private feedback only). Google's TOS prohibits this and the business can be penalized. Send everyone the same email with a Google review CTA. Trust customers to self-select.

============================================================
ENVIRONMENT VARIABLES (already added before this run)
============================================================

- GOOGLE_REVIEW_URL — Modern Classic's Google review destination URL
- UNSUBSCRIBE_SECRET — for signing unsubscribe tokens
- REVIEW_CRON_SECRET — auth for the daily cron job

If any are missing, return 503 from affected endpoints with a clear error.

============================================================
PART A — MARKETING CONSENT INFRASTRUCTURE
============================================================

Build the foundation that all future marketing emails depend on. The consent checkbox + Square Custom Attribute storage + the eligibility helper.

Files to build:

1. src/lib/square/customAttributes.ts (new)
   - Constants for the four attribute keys:
     - MARKETING_CONSENT_KEY = "marketing_consent"
     - MARKETING_CONSENTED_AT_KEY = "marketing_consented_at"
     - MARKETING_CONSENT_SOURCE_KEY = "marketing_consent_source"
     - MARKETING_UNSUBSCRIBED_AT_KEY = "marketing_unsubscribed_at"
   - ensureCustomAttributeDefinitions(): Promise<{ created: string[], existed: string[] }>
     - GET /v2/customers/custom-attribute-definitions
     - For any of the 4 keys missing, POST to create:
       - marketing_consent: schema type "boolean", visibility VISIBILITY_READ_WRITE_VALUES
       - marketing_consented_at: schema type "string" (ISO datetime), visibility VISIBILITY_READ_WRITE_VALUES
       - marketing_consent_source: schema type "string" (e.g., "booking_flow_step_4"), visibility VISIBILITY_READ_WRITE_VALUES
       - marketing_unsubscribed_at: schema type "string" (ISO datetime, nullable), visibility VISIBILITY_READ_WRITE_VALUES
     - Returns lists of which were created vs already existed.
     - Idempotent — safe to run multiple times.
   - getCustomAttribute(customerId, key): Promise<string | boolean | null>
   - setCustomAttribute(customerId, key, value): Promise<void>
   - getAllMarketingAttributes(customerId): Promise<MarketingAttributes>
     - Type: { consent: boolean, consentedAt: string | null, consentSource: string | null, unsubscribedAt: string | null }

2. src/pages/api/admin/init-custom-attributes.ts (new, admin-gated via Basic Auth + ADMIN_PASSWORD)
   - POST endpoint that calls ensureCustomAttributeDefinitions().
   - Returns JSON listing what was created vs already existed.
   - The user runs this ONCE after deployment to set up the definitions in Square. Don't auto-run on every request — wasteful.

3. src/lib/marketing/eligibility.ts (new)
   - isOptedInForMarketing({ customer, marketingAttributes }): boolean
   - Returns TRUE only if ALL of:
     - marketingAttributes.consent === true
     - marketingAttributes.unsubscribedAt is null/undefined/empty
     - customer.preferences?.email_unsubscribed !== true (Square's read-only flag — we respect it)
     - customer.email_address is present and looks like a valid email
   - Returns FALSE on any failure.
   - This is the GATE that every marketing email checks before sending. Phase 8, 9, 10 all use this same helper.

4. src/components/booking/Step4CustomerInfo.tsx (modify, from Phase 2)
   - Add a checkbox below existing fields, above the Next button.
   - Default state: UNCHECKED. Pre-checked defaults violate GDPR and are bad practice under CAN-SPAM. Customer must actively opt in.
   - Label text (exactly):
     "Send me appointment reminders, review requests, occasional offers, and product recommendations from Modern Classic Barbershop. I can unsubscribe anytime."
   - Style: small subtle checkbox + label. Should feel optional, not pushy. Match the rest of the form's typography.
   - Add to wizard state: marketingConsent: boolean (default false).
   - Pass marketingConsent through to /api/square/bookings as part of the customer object on submit.

5. src/lib/square/customers.ts (modify, from Phase 3)
   - findOrCreateCustomer accepts an additional optional parameter: marketingConsent?: boolean
   - After create or find, write custom attributes per these rules:
     - NEW customer (created): set marketing_consent = marketingConsent (true or false). If true, also set marketing_consented_at = now (ISO) and marketing_consent_source = "booking_flow_step_4".
     - EXISTING customer with consent === true and new submission unchecked: DO NOT overwrite. Persist existing consent. We don't silently revoke consent because someone forgot the checkbox.
     - EXISTING customer with consent === false/null and new submission true: set consent = true, update consented_at to now.
     - EXISTING customer with consent === true and new submission true: leave timestamps unchanged. Don't refresh.
     - Logic summary: the checkbox can flip false → true. NEVER true → false via the checkbox. Unsubscribing happens via the unsubscribe link only.

6. src/pages/api/square/bookings.ts (modify, from Phase 3)
   - Pass the marketingConsent flag through findOrCreateCustomer.
   - Log the consent decision in the same redacted-email log line.

============================================================
PART B — UNSUBSCRIBE FLOW
============================================================

Every marketing email needs a working unsubscribe link. Build it before sending any emails.

7. src/lib/marketing/unsubscribeToken.ts (new)
   - signUnsubscribeToken(customerId): string
     - HMAC-SHA256 signed token using UNSUBSCRIBE_SECRET. No expiration — unsubscribe links should work forever.
     - Format: base64url(customerId).base64url(signature)
   - verifyUnsubscribeToken(token): { customerId } | null
   - Native crypto, no library.

8. src/pages/api/marketing/unsubscribe.ts (new, GET endpoint)
   - Accepts ?token=<signedToken>
   - Verifies the token. If invalid → render an error page.
   - If valid → set marketing_unsubscribed_at = now (ISO) on the customer's custom attributes.
   - Render a confirmation page: "You've been unsubscribed from Modern Classic Barbershop emails. Sorry to see you go." Include a small "I changed my mind, resubscribe me" link that hits the same endpoint with ?action=resubscribe (which clears marketing_unsubscribed_at).
   - Mobile-friendly, branded styling.

9. src/pages/unsubscribe.astro (new)
   - The landing page rendered by the unsubscribe endpoint.
   - Two states based on query params: confirmation OR error (invalid/expired token).

============================================================
PART C — REVIEW REQUEST EMAIL TEMPLATE
============================================================

10. src/lib/email/templates/reviewRequest.ts (new)
    - reviewRequestHtml(props): string — branded HTML email
    - reviewRequestText(props): string — plaintext fallback
    - Props: { customerName, barberName, serviceName, appointmentDate, googleReviewUrl, unsubscribeUrl, shopAddress, shopPhone }
    - Email content (write the actual copy — match the masculine vintage barbershop aesthetic):
      - Subject: "How was your visit, [FirstName]?"
      - Hello [FirstName],
      - "Thanks for stopping by Modern Classic on [Friday] for your [Men's Haircut] with [Rick]. Hope you walked out feeling sharp."
      - "If you've got a minute, would you mind leaving us a quick Google review? It genuinely helps a small local shop like ours, and we'd really appreciate it."
      - Single primary CTA button: "Leave a Google Review" → links to GOOGLE_REVIEW_URL (via the click-tracking redirect — see Part D)
      - Smaller secondary text below: "If something didn't go right, just reply to this email — we'd rather hear from you directly than read about it later."
      - Sign-off: "— Michael, Rick & Clayton" (or just "— The Modern Classic team" depending on tone)
    - Footer (CAN-SPAM compliant):
      - Modern Classic Barbershop physical address (819 Linden Avenue, Zanesville, OH 43701)
      - Phone: 740-297-4462
      - "You're receiving this because you opted in when you booked your appointment. <a href='[unsubscribeUrl]'>Unsubscribe</a>"
    - Inline CSS for email-client compatibility (no <link>, no external stylesheets).
    - Dark/warm aesthetic — match the site. Don't go full black background; standard email best practice is light backgrounds with strong dark headings and a warm accent color for the CTA button.
    - Keep it short. The whole email should fit on one phone screen.

============================================================
PART D — CLICK TRACKING REDIRECT
============================================================

We want to know how many customers click the Google review CTA. Resend tracks opens/clicks but only at the "this email got clicked" level. We want our own data tied to the booking.

11. src/lib/marketing/clickToken.ts (new)
    - signClickToken({ reviewRequestId, destination }): string
      - reviewRequestId is a UUID we generate when we send the email.
      - destination is the URL we'll redirect to (Google review URL).
      - HMAC-signed using UNSUBSCRIBE_SECRET (same secret, different namespace prefix in the payload).
    - verifyClickToken(token): { reviewRequestId, destination } | null

12. src/pages/api/r/review.ts (new, GET endpoint)
    - URL: /r/review?t=<signedClickToken>
    - Verify token. If invalid → redirect to GOOGLE_REVIEW_URL anyway (don't break the customer's experience for our tracking).
    - If valid → record the click in the review request log (Part E), then redirect to the destination.
    - Use a 302 redirect, not 301.

============================================================
PART E — REVIEW REQUEST LOG
============================================================

We need to track which bookings have had a review email sent (avoid duplicates) and which got clicked (for stats).

13. Storage decision: use Square Customer Custom Attributes for per-customer rate limiting (last_review_request_sent_at to prevent over-asking) AND a simple JSON file in /tmp via Vercel KV alternative.

    BUT Vercel functions are stateless and /tmp doesn't persist. So:
    
    Use Vercel KV (Redis-backed key-value store, free tier). If Vercel KV isn't enabled on the project:
    - Tell the user to enable it: Vercel project → Storage → Create Database → KV. Returns connection env vars automatically.
    - Required env vars (Vercel injects automatically): KV_REST_API_URL, KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN, KV_URL.
    
    If for some reason KV can't be enabled, fall back to using Square Custom Attributes on the customer record with a "last_review_request_sent_at" + "last_review_request_booking_id" + "review_request_clicked_count" set of attributes. Less ideal but works.

14. src/lib/marketing/reviewLog.ts (new)
    - Uses @vercel/kv (acceptable lightweight dependency since it's needed for state).
    - recordReviewRequestSent({ customerId, bookingId, sentAt, reviewRequestId }): Promise<void>
      - Stores under key "review:sent:<reviewRequestId>" with the metadata.
      - Also stores under "review:by-booking:<bookingId>" → reviewRequestId for duplicate detection.
      - Also stores under "review:by-customer:<customerId>:latest" → sentAt timestamp.
    - hasReviewRequestBeenSent(bookingId): Promise<boolean>
    - getLastReviewRequestForCustomer(customerId): Promise<string | null> (returns timestamp)
    - recordReviewRequestClicked(reviewRequestId): Promise<void>
    - getReviewStats({ daysBack }): Promise<{ sent: number, clicked: number, clickRate: number, recent: Array<...> }>

============================================================
PART F — THE DAILY CRON JOB
============================================================

15. src/pages/api/cron/review-requests.ts (new)
    - Auth-gated by REVIEW_CRON_SECRET in the Authorization header (Vercel Cron sends this).
    - Logic:
      a. Compute the target window: bookings whose start_at falls between (now - 5 days) and (now - 2 days). The 2-day minimum gives the customer time to settle in. The 5-day max means we don't email people about a haircut they barely remember (and handles weekends — a Friday booking gets emailed Monday-Wednesday).
      b. Fetch ACCEPTED bookings in that window via /v2/bookings?location_id=...&start_at_min=...&start_at_max=... (Phase 1's wrapper). Square caps queries at 31 days, but our 3-day window is fine.
      c. For each booking:
         i. Skip if status !== "ACCEPTED".
         ii. Skip if hasReviewRequestBeenSent(booking.id) — already sent.
         iii. Fetch the customer via findCustomerByEmail or by customer_id.
         iv. Fetch their marketing custom attributes.
         v. Skip if !isOptedInForMarketing({ customer, marketingAttributes }).
         vi. Skip if last_review_request_sent_at < 30 days ago (don't bombard regulars who book frequently).
         vii. Fetch the service name (catalog) and barber name (team members) for the email.
         viii. Generate reviewRequestId (UUID).
         ix. Build the click-tracking URL: /r/review?t=<signClickToken({ reviewRequestId, destination: GOOGLE_REVIEW_URL })>
         x. Build the unsubscribe URL: /api/marketing/unsubscribe?token=<signUnsubscribeToken(customerId)>
         xi. Send via Resend's sendEmail (template: reviewRequest).
         xii. On Resend success: recordReviewRequestSent(...), set Square custom attribute last_review_request_sent_at = now.
         xiii. On Resend error: log and continue. Don't crash the whole batch.
      d. Return JSON with counts: { processed, sent, skipped: { alreadySent, optedOut, recentRequest, etc. }, failures }.
    - Log each step at INFO level. Redact emails in logs (a***@gmail.com).
    - Wrap the whole thing in a try/catch — never let one bad customer crash the cron.

16. vercel.json (modify)
    - Add a new cron entry alongside the existing daily rebuild:
      {
        "crons": [
          { "path": "/api/cron/rebuild", "schedule": "0 9 * * *" },
          { "path": "/api/cron/review-requests", "schedule": "0 14 * * *" }
        ]
      }
    - 14 UTC = 10 AM ET (9 AM during EST, 10 AM during EDT). Customers' likely-to-check-email window. Outside Modern Classic's open hours (shop opens at 9), so it's a quiet time for the API.

============================================================
PART G — ADMIN DASHBOARD STATS
============================================================

17. src/pages/admin/reviews.astro (new)
    - Basic Auth via ADMIN_PASSWORD (same pattern as /admin/bookings).
    - Server-renders stats from getReviewStats({ daysBack: 30 }) and getReviewStats({ daysBack: 90 }).
    - Layout:
      - Top: big numbers — "X review requests sent in last 30 days, Y clicked through (Z% click rate)"
      - Middle: same for 90 days
      - Bottom: table of last 50 review requests — customer initials (a***@example.com), service, sent date, clicked yes/no
    - Mobile-friendly. Match existing admin page styling.

18. src/pages/admin/bookings.astro (modify, from Phase 4)
    - Add a top nav with links to "Bookings" and "Reviews" so Michael can navigate between admin pages.

============================================================
PART H — RESEND EMAIL SENDING
============================================================

19. src/lib/email/resend.ts (modify, from Phase 5)
    - Add a sendReviewRequest(props): Promise<{ id: string }> function alongside sendMagicLink.
    - Same Resend HTTP API pattern. From: "Modern Classic Barbershop <bookings@designedtoelevate.co>"
    - Reply-To: modernclassicbarbershop@protonmail.com (so reply emails go to Michael, not us)
    - Headers: List-Unsubscribe: <unsubscribeUrl> (RFC 8058 — gives Gmail a one-click unsubscribe button in the inbox UI)
    - Headers: List-Unsubscribe-Post: List-Unsubscribe=One-Click (Gmail/Apple Mail honor this)

============================================================
CONSTRAINTS (HARD RULES)
============================================================

- Every marketing email MUST go through isOptedInForMarketing(). No exceptions, no bypass.
- Every marketing email MUST include the physical address in the footer (CAN-SPAM).
- Every marketing email MUST include a working one-click unsubscribe link.
- The List-Unsubscribe and List-Unsubscribe-Post headers MUST be present on review request emails (Gmail's bulk sender requirements as of 2024).
- NEVER do review gating. Single CTA goes to Google. Trust customers.
- The cron MUST be idempotent. Running it twice in a day must not double-send to anyone.
- The 30-day rate limit per customer MUST be enforced. A customer who comes in every 2 weeks shouldn't get 26 review requests/year. Once a month max.
- The unsubscribe link MUST work without requiring login.
- The unsubscribe action MUST be honored within 10 days (CAN-SPAM). We honor it instantly via the custom attribute flag.
- Token leak greps still apply: dist/ must contain zero hits for EAAA, RESEND, AUTH_SECRET, UNSUBSCRIBE_SECRET, REVIEW_CRON_SECRET, GOOGLE_REVIEW_URL.
- No `any` in TypeScript. Strict mode passes.
- All Square calls go through Phase 1's client wrapper.

============================================================
WHEN YOU FINISH
============================================================

Test plan (run end-to-end against production):

1. Run `npm run build`. Zero errors.
2. Token-leak greps return zero hits.
3. Initialize custom attributes:
   - POST /api/admin/init-custom-attributes with admin auth.
   - Confirm response shows all 4 keys either created or existing.
   - Verify in Square dashboard: open a customer profile, scroll to custom attributes, confirm 4 marketing fields are visible.
4. Test the consent checkbox:
   - Open /book in fresh browser.
   - Walk through wizard. Step 4 — verify checkbox is unchecked by default.
   - Check the box. Complete a test booking.
   - Verify in Square dashboard: that customer's custom attributes show marketing_consent = true, marketing_consented_at populated, marketing_consent_source = "booking_flow_step_4".
   - Cancel the test booking.
5. Test re-booking with existing customer:
   - Book again as the same customer. Step 4 — checkbox is unchecked.
   - Leave it unchecked. Complete the booking.
   - Verify the customer's marketing_consent is STILL true (we don't overwrite). Verify timestamps unchanged.
   - Cancel the test booking.
6. Test unsubscribe:
   - Manually generate a signed unsubscribe token for the test customer.
   - Visit /api/marketing/unsubscribe?token=<that token>.
   - Verify the confirmation page renders.
   - Verify the customer's marketing_unsubscribed_at is now set.
   - Verify isOptedInForMarketing returns false for them.
   - Test the resubscribe flow.
7. Test the email template:
   - Build a sample reviewRequestHtml with mock props.
   - Send to your real email via the Resend API directly.
   - Open it in Gmail. Verify:
     - Subject is correct.
     - Layout is clean on mobile and desktop.
     - The Google review CTA button works (lands on Modern Classic's review page).
     - The unsubscribe link works (lands on the unsubscribe confirmation page).
     - The physical address is in the footer.
     - Gmail shows the one-click unsubscribe button (if List-Unsubscribe headers worked).
8. Test the click tracking:
   - Click the review CTA in the test email.
   - Verify the redirect lands on Google review page.
   - Verify recordReviewRequestClicked was called and the click is logged.
9. Test the cron:
   - Trigger the cron manually: curl with REVIEW_CRON_SECRET to /api/cron/review-requests.
   - Verify the response shows 0 sent (no actual eligible bookings probably, depending on test data).
   - Create a test booking dated 3 days ago (or simulate by adjusting the cron's window logic temporarily). Trigger again. Verify a real email gets sent.
   - Cancel that test booking.
10. Test admin dashboard:
    - Visit /admin/reviews with admin auth.
    - Verify the stats page renders.
    - Should show whatever you actually sent during testing.
11. Cleanup: cancel any test bookings. Delete any test review log entries from KV if needed.
12. Report each step's outcome. List files created/modified. Flag any deviations.

Note: if Vercel KV isn't enabled on the project, stop and ask before proceeding to Part E. The user will need to enable it in the Vercel dashboard (free tier exists, but they may not have done it yet).
```

---

## Definition of done

- [ ] `GOOGLE_REVIEW_URL`, `UNSUBSCRIBE_SECRET`, `REVIEW_CRON_SECRET` set in Vercel and locally
- [ ] Vercel KV (or equivalent persistent storage) enabled
- [ ] Custom attribute definitions created in Square (verified via dashboard)
- [ ] Consent checkbox renders unchecked by default in booking flow
- [ ] Checking it sets all 3 consent custom attributes in Square
- [ ] Re-booking with existing customer doesn't overwrite previous true consent
- [ ] Unsubscribe link works without login, sets `marketing_unsubscribed_at`
- [ ] Resubscribe link clears `marketing_unsubscribed_at`
- [ ] Review request email renders correctly in Gmail, Apple Mail, Outlook
- [ ] CTA button links to the click-tracking redirect, which logs and forwards to Google
- [ ] Physical address and unsubscribe link present in footer (CAN-SPAM)
- [ ] List-Unsubscribe header gives Gmail's one-click unsubscribe UI
- [ ] Daily cron at 10 AM ET fires, processes eligible bookings, sends review requests
- [ ] Cron is idempotent — running twice doesn't double-send
- [ ] 30-day rate limit per customer enforced
- [ ] /admin/reviews shows accurate stats
- [ ] No tokens or secrets in client bundle
- [ ] All test bookings cleaned up

---

## What this unlocks for future phases

Phase 7 builds the **marketing email foundation** that Phases 8, 9, and 10 all depend on:

- **Consent infrastructure:** Custom Attribute definitions, the eligibility helper, the unsubscribe flow — all reused.
- **Email infrastructure:** Resend wrapper extended, template pattern established, click tracking ready, List-Unsubscribe headers in place.
- **Cron pattern:** Daily timed automation pulling from Square Bookings, idempotent, rate-limited.
- **Storage pattern:** Vercel KV (or fallback) for tracking what's been sent.

Phase 8 (rebook reminders) and Phase 9 (birthday/lifecycle) follow the exact same architecture — different cron schedule, different email template, same eligibility check, same unsubscribe handling. Each future marketing feature is a fraction of the work because the foundation is here.

---

## What this gives Michael

Within 30 days of launch:
- 50-100 review request emails sent (depending on shop volume)
- Probably 5-15 new Google reviews (typical conversion is 5-15%)
- Click rate visible in `/admin/reviews`
- Zero ongoing effort from Michael

Within 6 months:
- 300-600 review requests sent
- Likely 30-100 new Google reviews accumulated
- Modern Classic's local search ranking measurably improved
- Compounding traffic from new customers finding the shop on Google Maps

Within a year:
- The shop's review presence dominates Zanesville barbershop search
- Customer acquisition cost effectively zero from this channel
- Reviews keep flowing automatically as long as the cron runs

This is the highest-leverage feature in the entire build. One automation, running forever, generating local SEO equity that no competitor can buy.
