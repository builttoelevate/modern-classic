# Phase 1 — Square API Wrapper & Types

**Goal:** Build the foundation layer the rest of the booking system sits on. After this phase, every Square API call in the project goes through one typed, tested wrapper.

**Prerequisites:**
- Read `SQUARE_REFERENCE.md` first — every ID, scope, and endpoint is in there.
- Project is an existing Astro site deployed on Vercel.
- `SQUARE_ACCESS_TOKEN` is already set as a Vercel environment variable. If it isn't locally, add it to `.env` (gitignored).

**Out of scope for this phase:** UI, booking wizard, customer creation, booking writes. Those come in Phase 2 and 3. Stay focused.

---

## Paste this prompt into Claude Code

```
Read SQUARE_REFERENCE.md in the project root before doing anything else. Every ID, endpoint, and scope you need is in there.

Your task is Phase 1 of the Modern Classic booking system: build a typed, tested Square API wrapper. No UI work this phase — only the data layer.

Build these files:

1. src/lib/square/client.ts
   - One exported function: `squareFetch<T>(path, options)` that wraps fetch().
   - Pulls SQUARE_ACCESS_TOKEN from import.meta.env (server-side only — throw if it's accessed in a browser context).
   - Sets the three required headers on every call: Authorization Bearer, Square-Version 2025-10-16, Content-Type application/json.
   - Base URL: https://connect.squareup.com.
   - Throws a typed SquareApiError on non-2xx that includes Square's error category, code, and detail from the response body.
   - Generic over the response type so callers get full type inference.

2. src/lib/square/types.ts
   - Hand-rolled TypeScript types for the four shapes we use: Location, TeamMember, CatalogItem (with nested ItemVariation), and Booking. Don't pull in @square/square — we're keeping the dep tree small and only typing the fields we actually read. Reference the JSON shapes in SQUARE_REFERENCE.md section 5.
   - Plus our derived types: Service (a flattened, UI-friendly version of CatalogItem with its variations and eligible barbers), Barber (a TeamMember filtered for display), and AvailabilitySlot.

3. src/lib/square/locations.ts
   - `getLocation(): Promise<Location>` — calls GET /v2/locations and returns the Modern Classic location (id 523GMGEC1FY0Z). Throws if not found.

4. src/lib/square/team.ts
   - `getBarbers(): Promise<Barber[]>` — calls POST /v2/team-members/search with empty body, filters status=ACTIVE, excludes Bill Chicha (id TM3BJwsVNRbNXVZp), returns the three barbers with title-cased given names.

5. src/lib/square/catalog.ts
   - `getServices(): Promise<Service[]>` — calls GET /v2/catalog/list?types=ITEM,ITEM_VARIATION, filters to product_type=APPOINTMENTS_SERVICE, hides VIC (item id REEU27HVQBIP27KEI47RI73V), and reshapes each ITEM into a Service with its variations flattened. Each variation should carry id, name, priceCents (null for VARIABLE_PRICING), durationMinutes (computed from service_duration ms), version, eligibleTeamMemberIds, and pricingType.

6. src/lib/square/availability.ts
   - `searchAvailability({ serviceVariationId, teamMemberId, startAt, endAt }): Promise<AvailabilitySlot[]>` — calls POST /v2/bookings/availability/search with the segment_filters shape from SQUARE_REFERENCE.md section 5. teamMemberId is optional — if omitted, search across any eligible barber. Returns slots with start_at converted from UTC to America/New_York for display, plus the original UTC for booking. Cap the search range at 31 days (Square's limit) and throw if exceeded.

7. src/pages/api/square/health.ts
   - An Astro server endpoint at /api/square/health that calls getLocation, getBarbers, and getServices in parallel and returns { ok: true, locationName, barberCount, serviceCount } as JSON. This is our smoke test — running it should confirm the whole wrapper works end to end.

Constraints:
- Server-side only. Do not import any of these modules from .astro frontmatter that runs at build time without confirming the env var is available; do not import from any client component.
- Use native fetch. No axios, no @square/square SDK.
- Strict TypeScript. No `any`. If a Square response field is optional, type it optional.
- Format prices using cents internally (priceCents: 2500), only convert to dollars at the UI layer in later phases.
- Timezone conversion in availability.ts: use Intl.DateTimeFormat with timeZone: 'America/New_York'. Don't add date-fns-tz unless you hit a case Intl can't handle, in which case stop and ask.
- One small unit-test file per module is welcome but not required. If you write tests, use vitest and mock fetch.

When you finish:
1. Run `npm run build` and fix any type errors.
2. Run the dev server, hit /api/square/health in a browser, and paste the JSON response back.
3. List every file you created or modified.

Don't take screenshots — you can't. Use curl or code inspection to verify behavior.
```

---

## Definition of done

- [ ] Seven files exist and compile under `tsc --noEmit`.
- [ ] `/api/square/health` returns `{ ok: true, locationName: "Modern Classic", barberCount: 3, serviceCount: 8 }` (8 = 9 services minus VIC).
- [ ] No `any` in the diff. Strict mode passes.
- [ ] Token never appears in client-side code.
- [ ] No new runtime dependencies (only stdlib + native fetch).

If health returns the right shape, Phase 1 is done. Move to Phase 2.
