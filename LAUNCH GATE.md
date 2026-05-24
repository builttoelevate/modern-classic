# Launch Gate

This is the minimum pass standard. A service-based site should not go live unless every item below is complete.

For the full SEO standard, see `SEO_CHECKLIST.md` in the repo root.

-----

## How to use this file

**For Claude Code:** When the user asks you to “run the launch gate” or “check the launch gate”, walk through every item below against the current codebase and live site. Report each item as:

- **PASS** — verified working
- **FAIL** — broken or missing
- **NEEDS HUMAN VERIFICATION** — can’t be checked from the repo (e.g. GSC verification, NAP consistency with GBP, live site behavior)

For each FAIL or NEEDS HUMAN VERIFICATION item, list the specific file or action needed.

End with a single line: **READY TO LAUNCH** or **NOT READY — N items unchecked**.

Do not make changes during this check. This is a verification pass only.

**For the user:** Run this before pushing any new client site to production. Walk through it yourself, or ask Claude Code to run it. If anything is unchecked, the site isn’t ready.

-----

## The Gate

### Code

- [ ] Sitemap works (`@astrojs/sitemap` installed, `site` field set, `/sitemap-index.xml` loads)
- [ ] `public/robots.txt` exists and references the sitemap
- [ ] No accidental `noindex` on public pages
- [ ] Production build completes with no errors
- [ ] No broken internal links
- [ ] 404 page exists and is styled
- [ ] Canonical production domain works correctly
- [ ] www / non-www redirects are handled intentionally (one canonical, the other 301s to it)
- [ ] No staging or preview domain is indexable. Staging/preview environments should be blocked by `noindex` or auth-gated. Do not rely on `robots.txt` alone for private staging pages — it stops crawling but does not always prevent indexing if Google discovers the URL elsewhere.

### Per-Page Basics

- [ ] Every page has a unique `<title>`
- [ ] Every page has a unique meta description
- [ ] Every page has a canonical URL
- [ ] Every page has Open Graph + Twitter card tags
- [ ] Exactly one `<h1>` per page
- [ ] All images have `alt` text and `width`/`height` attributes

### Local SEO

- [ ] Business name, address, phone visible in footer
- [ ] NAP on site matches GBP exactly
- [ ] Phone number uses `tel:` link
- [ ] City and state appear on homepage and service pages
- [ ] Business hours visible

### Schema

- [ ] LocalBusiness (or subtype) schema on homepage
- [ ] Service schema on each service page
- [ ] Passes Google Rich Results Test with no critical errors

### Service Pages

- [ ] One dedicated page per major service
- [ ] Each has unique title, meta description, H1, and original copy
- [ ] Each has a visible CTA above the fold

### Conversion

- [ ] CTA above the fold on every major page
- [ ] Click-to-call works on mobile
- [ ] Contact/quote/booking path tested end-to-end
- [ ] Thank-you page or confirmation works

### Mobile

- [ ] Responsive from 320px up
- [ ] No horizontal scroll on any page
- [ ] Tap targets large enough

### Tracking

- [ ] Google Search Console verified
- [ ] Sitemap submitted in GSC
- [ ] Analytics installed (PostHog / GA4)
- [ ] At minimum: `phone_click` and `form_submit` or `booking_click` events firing
- [ ] If the site has a quote wizard, `quote_start` and `quote_complete` events must also fire

### Final Cleanup

- [ ] No staging URLs or placeholder content remain
- [ ] No demo/stock images remain unless intentional
- [ ] Lighthouse SEO score 95+ on homepage
- [ ] Lighthouse Performance 85+ on mobile homepage

-----

**If any box is unchecked, the site is not ready to launch.**