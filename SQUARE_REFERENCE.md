# Modern Classic — Square API Reference

This doc is the single source of truth for the Astro site's Square integration. Drop it in the project root (or `/docs`) so Claude Code can read it across sessions.

**Last verified:** April 30, 2026
**Square API version header:** `Square-Version: 2025-10-16`
**Production base URL:** `https://connect.squareup.com`

---

## 1. Authentication

Square personal access token (production). Owner: Michael Croston. Token is rotated; current value lives in `.env` as `SQUARE_ACCESS_TOKEN` — never commit it.

```
Authorization: Bearer ${SQUARE_ACCESS_TOKEN}
Square-Version: 2025-10-16
Content-Type: application/json
```

**Required scopes** (verified working):
- `MERCHANT_PROFILE_READ` — for `/v2/locations`
- `APPOINTMENTS_READ` / `APPOINTMENTS_ALL_READ` — for `/v2/bookings`
- `ITEMS_READ` — for `/v2/catalog`
- `EMPLOYEES_READ` — for `/v2/team-members/search`
- `APPOINTMENTS_WRITE` / `APPOINTMENTS_BUSINESS_SETTINGS_READ` — needed to **create** bookings (verify on Michael's app config before going live)
- `CUSTOMERS_READ` / `CUSTOMERS_WRITE` — to find-or-create customers at booking time

---

## 2. Location

| Field | Value |
|---|---|
| **Location ID** | `523GMGEC1FY0Z` |
| **Merchant ID** | `MAXFMNGPB3F4N` |
| **Business name** | Modern Classic Barbershop |
| **Address** | 819 Linden Avenue, Zanesville, OH 43701 |
| **Phone** | +1 740-297-4462 |
| **Email** | modernclassicbarbershop@protonmail.com |
| **Timezone** | `America/New_York` (DST applies — always do tz math in this zone) |
| **Currency** | USD |
| **Square site** | https://modern-classic.square.site |
| **Instagram** | @modernclassicbarbershop |
| **Logo URL** | `https://square-web-production-f.squarecdn.com/files/fa83e2926ea24d7fefb76381ef9ae1a3a8aaa26b/original.jpeg` |

### Business hours (local time, America/New_York)

| Day | Open | Close |
|---|---|---|
| Mon | 09:00 | 18:00 |
| Tue | 09:00 | 18:00 |
| Wed | 09:00 | 18:00 |
| Thu | 09:00 | 18:00 |
| Fri | 09:00 | 18:00 |
| Sat | 09:00 | 15:00 |
| Sun | CLOSED | — |

**Source of truth:** business hours are also returned by `GET /v2/locations` if Michael edits them in Square. Prefer fetching live at build time over hardcoding.

---

## 3. Team members (barbers)

Display only the three barbers. Filter out Bill (web dev account) when rendering.

| ID | Name | Role | Show on site? |
|---|---|---|---|
| `523GMGEC1FY0Z` | **Michael Croston** | Owner | ✅ |
| `TMZ4GRNFpRhnzLbv` | **Rick Chambers** | Master Barber | ✅ |
| `TMwUNkXCCC_i3vyZ` | **Clayton Bagent** | Master Barber | ✅ |
| `TM3BJwsVNRbNXVZp` | Bill Chicha | Web Development | ❌ exclude |

**Note:** Michael's team member ID is the same string as the location ID — that's a quirk of how Square handles the original owner. Don't assume it's a bug.

**Display name normalization** for the UI:
- `MICHAEL` → "Michael"
- `RICK` → "Rick"
- `CLAYTON` → "Clayton"

(All-caps in catalog data; render in title case.)

---

## 4. Services (catalog)

9 services, 14 bookable variations. Variation IDs are what the booking API consumes (`appointment_segments[].service_variation_id`), not item IDs.

### Display services

| Service | Variations | Price | Duration | Eligible barbers |
|---|---|---|---|---|
| **Beard Trim & Edge** | 1 (any barber) | $25 | 30 min | All 3 |
| **Men's Haircut** | 3 (per barber) | $30 | 30 min (Clayton 35) | Per variation |
| **Haircut & Beard Service** | 3 (per barber) | $45 | 45–60 min | Per variation |
| **Shampoo + Style** | 1 | $15 | 15 min | Michael, Clayton |
| **Kids Haircut (10 & under)** | 1 | $25 | 30 min | All 3 |
| **Straight Razor Shave** | 1 | $30 | 30 min | All 3 |
| **Haircut + Design** | 1 | Variable ($30–45) | 60 min | All 3 |
| ***NEW CUSTOMERS*** | 1 | Variable ($30–45) | 60 min | All 3 |
| **VIC** | 2 | $100 / variable | 60 min | Not bookable — hide |

### Variation ID lookup table

Use this when constructing `appointment_segments`.

| Service | Variation label | Variation ID | Team members | Price (¢) | Duration (ms) |
|---|---|---|---|---|---|
| Beard Trim & Edge | (default) | `3QMIIG6HB5G47PHKQALEAJAI` | All 3 | 2500 | 1800000 |
| Men's Haircut | MICHAEL | `4LWCW5PAZUJNMUIBM2K676PP` | Michael only | 3000 | 1800000 |
| Men's Haircut | RICK | `FODJXYHEY427JRKF74EMLS2N` | Rick only | 3000 | 1800000 |
| Men's Haircut | CLAYTON | `K7KVVXQX3HBJAK52IFL7CERQ` | Clayton only | 3000 | 2100000 |
| Haircut & Beard | MICHAEL | `N4IJA4NS7UAGUCVKB2W7CNT6` | Michael only | 4500 | 3600000 |
| Haircut & Beard | CLAYTON | `4G4VGRJLFZ6GRPHHZX4SNREA` | Clayton only | 4500 | 2700000 |
| Haircut & Beard | RICK | `ISWN4J5VU6HH6CDPX5IEWG4K` | Rick only | 4500 | 3600000 |
| Shampoo + Style | (default) | `CLAOC767V22KP4NERKQZ7QE2` | Michael, Clayton | 1500 | 900000 |
| Kids Haircut | Regular | `VDNEP7SQSCS6Q4UGPJZLCQKF` | All 3 | 2500 | 1800000 |
| Straight Razor Shave | Regular | `TPW66NFYZQCM53WYEMXKMZ5P` | All 3 | 3000 | 1800000 |
| Haircut + Design | Haircut + Design | `EKJTELC37SIPOFPK4MNJ276W` | All 3 | Variable | 3600000 |
| *NEW CUSTOMERS* | (default) | `TIVNNSLPAS6SJ4W74CXD5K6Y` | All 3 | Variable | 3600000 |

**Note on variations:** When a service has per-barber variations (Men's Haircut, Haircut & Beard), the user picks the barber by picking the variation. When a service has one shared variation (Beard Trim, Kids Cut, etc.), the barber is a separate choice.

**Note on VIC:** Currently `available_for_booking: false`. Don't render. Ask Michael what it is before deciding what to do with it.

---

## 5. API endpoints we'll use

All hit `https://connect.squareup.com`. Examples below assume `$token` and standard headers.

### List locations
```
GET /v2/locations
```
Use to verify token + pull live business hours.

### Search team members
```
POST /v2/team-members/search
Body: {}
```
Returns all team members. Filter by status `ACTIVE` and exclude Bill.

### List catalog (services)
```
GET /v2/catalog/list?types=ITEM,ITEM_VARIATION
```
Filter to `item_data.product_type === "APPOINTMENTS_SERVICE"`. Run at build time and cache.

### Search availability
```
POST /v2/bookings/availability/search
Body:
{
  "query": {
    "filter": {
      "start_at_range": {
        "start_at": "2026-05-01T13:00:00Z",
        "end_at":   "2026-05-08T13:00:00Z"
      },
      "location_id": "523GMGEC1FY0Z",
      "segment_filters": [
        {
          "service_variation_id": "<variation_id>",
          "team_member_id_filter": {
            "any": ["<team_member_id>"]
          }
        }
      ]
    }
  }
}
```
- `start_at_range` is required and capped at **31 days**.
- Returns `availabilities[]` with `start_at` (ISO UTC) and the matched team member.
- Convert `start_at` to `America/New_York` for display.

### Find or create customer
```
POST /v2/customers/search
Body: { "query": { "filter": { "email_address": { "exact": "..." } } } }
```
If empty, then:
```
POST /v2/customers
Body: { "given_name": "...", "family_name": "...", "email_address": "...", "phone_number": "..." }
```

### Create booking
```
POST /v2/bookings
Body:
{
  "idempotency_key": "<uuid>",
  "booking": {
    "start_at": "2026-05-01T13:00:00Z",
    "location_id": "523GMGEC1FY0Z",
    "customer_id": "<customer_id>",
    "customer_note": "<optional message>",
    "appointment_segments": [
      {
        "duration_minutes": 30,
        "service_variation_id": "<variation_id>",
        "service_variation_version": <int from catalog>,
        "team_member_id": "<team_member_id>"
      }
    ]
  }
}
```
- `idempotency_key` is required — use `crypto.randomUUID()`.
- `service_variation_version` must match what's in the catalog (it's a Square optimistic-locking field). Pull it from the same catalog fetch as `service_variation_id`.

### Read bookings
```
GET /v2/bookings?location_id=523GMGEC1FY0Z&limit=50
```
Used during dev to verify our writes show up. Not needed in production UI.

---

## 6. Architecture notes

### Where to call Square from
- **Build time (Astro static):** `/v2/locations`, `/v2/catalog/list`, `/v2/team-members/search`. These rarely change. Cache as JSON in the build output.
- **Runtime (server endpoint):** `/v2/bookings/availability/search`, `/v2/customers/*`, `/v2/bookings`. These need live data and must keep the token server-side.

### Token security
The Square access token is **server-only**. It must never reach the browser:
- Build-time fetches happen on the Vercel build runner — fine.
- Runtime fetches go through Astro server endpoints (`src/pages/api/*.ts`) on Vercel serverless functions — fine.
- Never put `SQUARE_ACCESS_TOKEN` in any code path that ships to the client.

### Timezone handling
- Square returns and accepts UTC ISO timestamps everywhere.
- Modern Classic operates in `America/New_York` (DST: EDT in summer, EST in winter).
- Always convert to `America/New_York` for display, and convert back to UTC before hitting `/v2/bookings/availability/search` or `/v2/bookings`.
- Use `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` or a small lib like `date-fns-tz`.

### Idempotency
Generate one `idempotency_key` per booking attempt and reuse it on retry. If the user double-clicks "Confirm," reusing the key means Square returns the same booking instead of creating two.

### Rate limits
Square's documented limit is 700 req/min per access token across the org. We won't come close, but cache build-time fetches and don't poll availability — fetch on demand when the user picks a date.

---

## 7. Booking flow (custom UI)

Five steps. Each step's data comes from the previous step's selection.

1. **Pick a service** — render the 8 visible services (hide VIC).
2. **Pick a barber** — filter team members to those eligible for the chosen service (intersect with the variation's `team_member_ids`). For services with per-barber variations (Men's Haircut, Haircut & Beard), this step also resolves which variation to use.
3. **Pick a date and time** — call `/v2/bookings/availability/search` for the next 14–31 days, render slots in 30-min buckets in local time.
4. **Customer info** — name, email, phone, optional note.
5. **Confirm** — find-or-create customer → create booking with idempotency key → success page.

---

## 8. Known gotchas

1. **Variable-pricing services** (Haircut + Design, NEW CUSTOMERS): Square doesn't accept a price at booking time for these — the price is set when the appointment is rung up in person. UI should display the range ($30–$45) without asking the user to pick.
2. **Clayton's Men's Haircut is 35 min, not 30** (`service_duration: 2100000` ms). The duration field on each variation is the source of truth — don't hardcode 30.
3. **`service_variation_version`** is mandatory on `POST /v2/bookings` and changes whenever Michael edits the catalog. Always pull it fresh — never hardcode.
4. **Booking too close to start time:** Square enforces a minimum lead time set in Michael's booking preferences (commonly 1–24 hours). The availability search already excludes too-soon slots, but trust the API — don't add custom lead-time logic.
5. **Cancellation policy** is in every service description (24-hour notice, no-show charge). Surface it on the confirmation step so customers see it before booking.
6. **Square Sandbox vs Production:** All IDs in this doc are production. Don't mix tokens — sandbox bookings won't show up in Michael's real dashboard.

---

## 9. Quick test commands (PowerShell)

```powershell
$token = "PASTE_TOKEN".Trim()

# Verify token + see locations
curl.exe --ssl-no-revoke https://connect.squareup.com/v2/locations `
  -H "Square-Version: 2025-10-16" `
  -H "Authorization: Bearer $token"

# List recent bookings
curl.exe --ssl-no-revoke "https://connect.squareup.com/v2/bookings?location_id=523GMGEC1FY0Z&limit=5" `
  -H "Square-Version: 2025-10-16" `
  -H "Authorization: Bearer $token"

# Pull catalog
curl.exe --ssl-no-revoke "https://connect.squareup.com/v2/catalog/list?types=ITEM,ITEM_VARIATION" `
  -H "Square-Version: 2025-10-16" `
  -H "Authorization: Bearer $token"

# List team members
curl.exe --ssl-no-revoke https://connect.squareup.com/v2/team-members/search -X POST `
  -H "Square-Version: 2025-10-16" `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -d "{}"
```

---

## 10. To-do before going live

- [ ] Confirm `APPOINTMENTS_WRITE` scope is enabled on Michael's Square app
- [ ] Confirm `CUSTOMERS_WRITE` scope is enabled
- [ ] Ask Michael what the VIC service is and whether to keep it hidden
- [ ] Test booking creation end-to-end against a sandbox first if possible
- [ ] Add the cancellation policy to the confirm step UI
- [ ] Set up Resend for booking confirmation emails (separate from Square's own)
- [ ] Decide whether to send SMS confirmations via Twilio (matches the TintShopLaunch pattern)
