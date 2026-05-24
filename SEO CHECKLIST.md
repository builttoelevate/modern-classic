# SEO Checklist & Workflow for Service-Based Websites

This file is the SEO standard AND the workflow Claude Code follows in this repo.

If you are Claude Code reading this file, follow the **Workflow** section below before doing anything else.

-----

## Platform note

This checklist is written for **Astro service-business sites** by default. The SEO principles apply to all service-business websites, but implementation details (sitemap config, SEO component file paths, etc.) may differ for WordPress, Webflow, Wix, Squarespace, Shopify, or other platforms. Adapt platform-specific items as needed; keep the standards.

-----

## Workflow (Claude Code: read this first)

When the user asks you to “run the SEO checklist” or “follow SEO_CHECKLIST.md”, execute this workflow in order. **Do not skip steps. Do not combine steps. Wait for user approval between each step.**

### Step 1 — Audit (no changes)

Audit the current codebase against the checklist below. **Do not change any code. Do not install anything. Do not commit anything.**

Produce a report with four sections:

- **A. PASSES** — what the site already does correctly.
- **B. CODE FIXES** — safe changes you can make in the codebase with no content decisions required. (sitemap, robots.txt, SEO component, canonicals, OG/Twitter tags, schema components, image alt/dimensions, internal links, etc.)
- **C. CONTENT CHANGES** — things that need user approval before changing. (titles, meta descriptions, H1s, new copy, FAQs, city/service-area sections.)
- **D. EXTERNAL TASKS** — things the user needs to do outside the repo. (GSC, Bing, Ahrefs, GBP alignment, directory listings.)

For each issue, list the specific files or pages affected.

End the audit with:

- Pass/fail summary by checklist section
- Prioritized action plan, highest SEO impact first
- A recommended **first PR** scoped tight enough to ship in one pass (code fixes only, no content rewrites)

**Then stop and wait for approval.**

### Step 2 — First PR (code fixes only)

When the user approves, execute the recommended first PR. **Code fixes only — no content rewrites, no title or meta changes.**

When done, report:

- List of files changed
- What each change does
- How to test locally before pushing

**Then stop and wait for the next instruction.**

### Step 3 — Content changes (one batch at a time)

When the user asks for content changes, work in batches — one type per batch, in this order:

1. Titles and meta descriptions
1. H1s
1. FAQs
1. City / service-area mentions
1. New service page copy (only if needed)

For each item in a batch:

- Show the current version
- Show the proposed version
- Explain why it’s better

**Do not apply changes until the user approves.** Then apply only the approved items.

### Step 4 — Launch gate check

When the user is ready to call it done, walk through `LAUNCH_GATE.md` in the repo root. Report any unchecked items.

### Step 5 — Final to-do list for the user

After Steps 1–4 are complete (or any time the user asks for “my SEO to-dos”), output a consolidated **HUMAN TO-DO LIST** of every action the user needs to take outside the codebase. This is the user’s checklist for things Claude Code cannot do.

Group the to-dos into these sections, only including items that actually apply to this site:

**Verification & Submission**

- Verify site in Google Search Console (search.google.com/search-console)
- Submit sitemap in GSC (`/sitemap-index.xml`)
- Verify site in Bing Webmaster Tools (bing.com/webmasters)
- Submit sitemap in Bing
- Verify site in Ahrefs Webmaster Tools (ahrefs.com/webmaster-tools)
- Run Ahrefs Site Audit

**Google Business Profile**

- Claim / verify GBP listing
- Confirm NAP on GBP matches the site exactly
- Confirm business hours match
- Confirm services listed on GBP match site services
- Confirm primary category is correct
- Add/refresh business photos
- Confirm website link points to correct URL (with UTM if applicable)
- Confirm booking/appointment link works

**Directory Listings**

- Bing Places
- Apple Business Connect (businessconnect.apple.com)
- Yelp
- Facebook business page (if relevant)
- Industry-specific directories (e.g. film manufacturer dealer locator for tint, booking platforms for barbershops)
- Local chamber / community directories

**Score & Performance Checks**

- Run Lighthouse on homepage (Chrome DevTools → Lighthouse, or pagespeed.web.dev)
- Run Lighthouse on top 2–3 service pages
- Run Google Rich Results Test on homepage and service pages (search.google.com/test/rich-results)
- Crawl site with Screaming Frog free (up to 500 URLs) to catch any missed issues

**Reviews**

- Confirm Google review link works
- Add review request to thank-you page or follow-up flow

**Tracking Verification**

- Confirm analytics events fire in production (`phone_click`, `form_submit`, `quote_start`, etc.)
- Confirm GBP website link uses UTM parameters

For each to-do, include the **direct URL** where applicable so the user can click straight to it.

End the list with: **“That’s everything outside the repo. Knock these out and the site is fully covered.”**

-----

## Constraints (always apply)

- Do not build a public-facing SEO score widget.
- Do not add WordPress-style plugins.
- Keep all SEO components reusable so they can be copied to other client repos.
- Do not modify this file (`SEO_CHECKLIST.md`) or `LAUNCH_GATE.md`.
- External tasks (GSC verification, GBP alignment, directory listings) are the user’s job — flag them, don’t try to do them.

-----

## The Checklist

Use this checklist for every service-based website launch and quarterly SEO audit.

Examples:

- Barbershops
- Auto detailers
- Window tint shops
- Contractors
- Cleaning companies
- Landscaping companies
- HVAC/plumbing/electrical businesses
- Local transportation or bus companies

The goal is not to chase a fake SEO score. The goal is to make every site crawlable, indexable, locally relevant, trustworthy, fast, and built to convert.

-----

### 1. Technical Foundation

- [ ] Site is deployed on HTTPS
- [ ] No mixed-content warnings
- [ ] `@astrojs/sitemap` is installed and configured
- [ ] `site` field is set correctly in `astro.config.mjs`
- [ ] Sitemap generates successfully
- [ ] `public/robots.txt` exists
- [ ] `robots.txt` references the sitemap
- [ ] 404 page exists and is styled
- [ ] Production build completes with no errors
- [ ] No major console errors on live site
- [ ] No broken internal links
- [ ] All internal links use root-relative or valid absolute URLs
- [ ] No accidental `noindex` tags on public pages
- [ ] No important page is blocked by `robots.txt`

Astro note:

- Use `@astrojs/sitemap` for sitemap generation.
- Make sitemap discovery easier through `robots.txt` and/or a sitemap link in the page head.

-----

### 2. Global SEO Setup

- [ ] Reusable SEO component or layout-level SEO system
- [ ] Default title fallback
- [ ] Default meta description fallback
- [ ] Default Open Graph image
- [ ] Default business name
- [ ] Default phone number
- [ ] Default service area
- [ ] Default canonical URL logic
- [ ] `lang="en"` on the `<html>` tag
- [ ] Favicon installed
- [ ] Apple touch icon installed
- [ ] Social preview image set

Recommended files:

```txt
src/components/SEO.astro
src/components/schema/LocalBusinessSchema.astro
src/components/schema/ServiceSchema.astro
src/components/schema/FAQSchema.astro
src/components/schema/BreadcrumbSchema.astro
src/data/siteConfig.ts
src/data/services.ts
```

-----

### 3. Per-Page Meta Tags

- [ ] Unique `<title>`
- [ ] Title includes service and/or location where relevant
- [ ] Title is written for clicks, not just keywords
- [ ] Unique meta description
- [ ] Meta description includes service, location, proof, or CTA where possible
- [ ] Canonical URL
- [ ] Open Graph title
- [ ] Open Graph description
- [ ] Open Graph image
- [ ] Open Graph URL
- [ ] Twitter/X card tags
- [ ] No duplicate titles across major pages
- [ ] No duplicate meta descriptions across major pages

Title target: roughly 50–65 characters when possible.
Meta description target: roughly 140–160 characters when possible.

Do not force the length if it reads better slightly shorter or longer.

-----

### 4. Page Structure

- [ ] Exactly one `<h1>`
- [ ] H1 clearly explains the page topic
- [ ] H1 includes primary service and location where relevant
- [ ] Logical heading structure
- [ ] No skipped hierarchy like H1 directly to H4
- [ ] H2s describe actual page sections
- [ ] No vague headings like “Welcome” or “Learn More”
- [ ] Body copy is real HTML text, not text trapped inside images
- [ ] Important CTAs are real links or buttons
- [ ] Navigation is crawlable
- [ ] Footer links are crawlable

-----

### 5. Local SEO Foundation

- [ ] Google Business Profile claimed and verified
- [ ] Google Business Profile fully completed
- [ ] Business name matches real-world business name
- [ ] NAP is consistent across website, GBP, Bing, Apple Maps, Yelp, and major directories
- [ ] NAP appears in the footer
- [ ] NAP appears on the contact page
- [ ] Phone number uses `tel:` link
- [ ] Address is visible if the business has a public location
- [ ] Service area is clearly listed if the business travels to customers
- [ ] Business hours are visible
- [ ] Contact page includes directions or map section
- [ ] Google Map embedded where it helps users
- [ ] Primary city and state appear naturally on homepage
- [ ] Primary city and state appear naturally on service pages
- [ ] Nearby service areas are mentioned naturally where appropriate
- [ ] GBP website link uses UTM tracking if analytics are installed

Important: Google’s local ranking is mainly based on relevance, distance, and prominence. The website supports those signals, but the Google Business Profile is critical.

-----

### 6. Google Business Profile Alignment

The website and GBP should agree.

- [ ] Website business name matches GBP
- [ ] Website address matches GBP
- [ ] Website phone matches GBP
- [ ] Website hours match GBP
- [ ] Website services match GBP services
- [ ] Website categories support the GBP primary category
- [ ] Photos on site and GBP are current
- [ ] Review link works
- [ ] Booking/appointment link works
- [ ] Service area on site matches GBP service area
- [ ] Business description and website copy do not contradict each other

-----

### 7. Structured Data / Schema

Use JSON-LD where appropriate.

- [ ] LocalBusiness schema or specific subtype on homepage
- [ ] Organization schema if appropriate
- [ ] Service schema on service pages
- [ ] BreadcrumbList schema on inner pages
- [ ] FAQPage schema only where visible FAQs exist
- [ ] Review/AggregateRating schema only if it is honest, visible, and guideline-safe

Recommended LocalBusiness fields:

- Business name
- URL
- Phone
- Address
- Geo coordinates
- Opening hours
- Image/logo
- Price range if appropriate
- Area served
- SameAs links
- Services offered

Testing:

- [ ] Test structured data with Google Rich Results Test
- [ ] Fix critical errors
- [ ] Review warnings when practical

Important: Structured data helps Google understand content and may make pages eligible for rich results, but Google does not guarantee rich results.

-----

### 8. Service Page Requirements

Every major service should have its own page.

- [ ] One clear primary keyword
- [ ] One clear location target where relevant
- [ ] Unique title
- [ ] Unique meta description
- [ ] One H1
- [ ] Clear above-the-fold CTA
- [ ] Original service-specific copy
- [ ] At least 500 words for important service pages when practical
- [ ] Real photos of the service/work
- [ ] Pricing, starting price, or quote expectation where possible
- [ ] Process explanation
- [ ] Benefits section
- [ ] FAQs
- [ ] Internal links to related services
- [ ] Link back to contact/quote/booking page
- [ ] Service schema
- [ ] Local proof where possible

Avoid:

- Thin pages with only 100–200 words
- Copy/paste service pages with swapped keywords
- Fake city pages with no useful local content
- Generic AI-sounding filler copy

-----

### 9. Content Quality & Trust

- [ ] Real business photos
- [ ] Real team or owner information
- [ ] Real customer reviews or testimonials
- [ ] Link to Google reviews
- [ ] Years in business or founding story
- [ ] Certifications or credentials
- [ ] Product/brand certifications where relevant
- [ ] Warranty information where relevant
- [ ] Before/after photos where relevant
- [ ] Clear explanation of what makes the business different
- [ ] Clear expectations about pricing, timelines, or booking

For service businesses, trust often converts better than clever copy.

-----

### 10. Image SEO

- [ ] Descriptive alt text for meaningful images
- [ ] Empty `alt=""` for decorative images
- [ ] Width and height attributes set
- [ ] Images are properly compressed
- [ ] Use WebP/AVIF where practical
- [ ] Images are not larger than needed
- [ ] Below-fold images use lazy loading
- [ ] Above-the-fold hero image is not lazy-loaded
- [ ] Important hero image may use `fetchpriority="high"`
- [ ] File names are descriptive where possible
- [ ] No important text is trapped inside an image

Example:

```html
<img
  src="/images/window-tint-before-after.webp"
  alt="Before and after window tinting on a black sedan in Coshocton Ohio"
  width="1200"
  height="800"
  loading="lazy"
  decoding="async"
/>
```

-----

### 11. Internal Linking

- [ ] Homepage links to all major service pages
- [ ] Service pages link to related services
- [ ] Service pages link to quote/contact/booking page
- [ ] Footer links to key pages
- [ ] Navigation links are descriptive
- [ ] No “click here” anchor text for important links
- [ ] Breadcrumbs on inner pages where appropriate
- [ ] Every indexable page is reachable through internal links
- [ ] No orphan service pages

-----

### 12. Conversion SEO

SEO is not just traffic. The page has to turn visitors into leads.

- [ ] CTA above the fold
- [ ] CTA repeated after major sections
- [ ] Click-to-call on mobile
- [ ] Quote/contact/booking CTA
- [ ] Trust proof near CTAs
- [ ] Simple contact path
- [ ] Contact info reachable in under 2 clicks
- [ ] Forms are short and easy to complete
- [ ] Thank-you page or conversion confirmation
- [ ] Form tracking installed
- [ ] Call tracking or call-click tracking installed if possible

Recommended CTA examples:

- Get a Quote
- Book Now
- Call Now
- Schedule Service
- Request an Estimate
- Text the Shop

-----

### 13. Mobile UX

- [ ] Responsive from 320px to 1920px
- [ ] No horizontal scrolling
- [ ] Tap targets are large enough
- [ ] Font sizes are readable
- [ ] Header/navigation works on mobile
- [ ] CTA is easy to reach
- [ ] Forms are easy to use
- [ ] Phone number is clickable
- [ ] Sticky CTA exists where appropriate
- [ ] Images scale correctly
- [ ] Page does not feel cramped

-----

### 14. Performance / Core Web Vitals

Minimum goals:

- [ ] Lighthouse Performance score 85+ on mobile when practical
- [ ] Lighthouse SEO score 95+
- [ ] LCP under 2.5 seconds
- [ ] CLS under 0.1
- [ ] INP under 200ms
- [ ] Images optimized
- [ ] Fonts optimized
- [ ] `font-display: swap` used where appropriate
- [ ] No unnecessary third-party scripts
- [ ] No heavy unused JavaScript
- [ ] No render-blocking resources that can be avoided
- [ ] CSS is not bloated
- [ ] Analytics scripts are loaded responsibly

Do not chase a perfect score at the expense of conversion, tracking, or visual quality.

-----

### 15. Analytics & Tracking

- [ ] Google Search Console
- [ ] Bing Webmaster Tools
- [ ] Ahrefs Webmaster Tools
- [ ] GA4, PostHog, or another analytics platform
- [ ] Sitemap submitted in GSC
- [ ] Sitemap submitted in Bing
- [ ] Form submission tracking
- [ ] Click-to-call tracking
- [ ] Click-to-text tracking where relevant
- [ ] Booking click tracking
- [ ] Quote wizard start tracking
- [ ] Quote wizard completion tracking
- [ ] Thank-you page or conversion event
- [ ] GBP website link tracking with UTM parameters

Core events to track:

- `phone_click`
- `sms_click`
- `form_submit`
- `booking_click`
- `quote_start`
- `quote_complete`
- `quote_abandon`
- `direction_click`

-----

### 16. Off-Site Local SEO Basics

- [ ] Google Business Profile
- [ ] Bing Places
- [ ] Apple Business Connect / Apple Maps
- [ ] Yelp
- [ ] Facebook business page if relevant
- [ ] Industry-specific directories
- [ ] Local chamber or community directories where relevant
- [ ] Supplier/manufacturer dealer listings where relevant
- [ ] NAP is consistent across all listings

Examples:

For window tint:

- Film manufacturer dealer locator
- Tint/wrap/detail directories where relevant

For barbershops:

- Booking platform profile
- Local barbershop directories where relevant

For contractors:

- Angi/HomeAdvisor only if strategically useful
- BBB only if client wants it
- Manufacturer/certification listings

-----

### 17. Review Strategy

- [ ] Google review link available
- [ ] Review CTA on thank-you page
- [ ] Review CTA in follow-up email/text
- [ ] Reviews displayed on site
- [ ] Reviews are real and current
- [ ] Badges or rating claims are accurate
- [ ] Review count is updated periodically
- [ ] Review request timing makes sense for the business

Do not fake reviews, fake ratings, or inflate review counts.

-----

### 18. Accessibility Basics

- [ ] Good color contrast
- [ ] Buttons have accessible names
- [ ] Forms have labels
- [ ] Images have appropriate alt text
- [ ] Navigation works with keyboard
- [ ] Focus states are visible
- [ ] Text is readable on mobile
- [ ] No autoplay audio/video
- [ ] Important content is not hidden from screen readers

Accessibility helps users and often improves overall site quality.

-----

### 19. Launch Checklist

Before launch:

- [ ] Run production build
- [ ] Crawl site with Screaming Frog or similar
- [ ] Run Lighthouse on homepage
- [ ] Run Lighthouse on major service pages
- [ ] Test contact forms
- [ ] Test booking links
- [ ] Test phone links on mobile
- [ ] Test SMS links on mobile
- [ ] Test map/directions links
- [ ] Check metadata previews
- [ ] Validate schema
- [ ] Submit sitemap to GSC
- [ ] Submit sitemap to Bing
- [ ] Confirm analytics events are firing
- [ ] Confirm no accidental staging URLs remain
- [ ] Confirm no placeholder content remains
- [ ] Confirm no stock/demo images remain unless intentionally used

-----

### 20. Quarterly SEO Audit

Every quarter:

- [ ] Review GSC clicks/impressions
- [ ] Review GSC indexing issues
- [ ] Review top queries
- [ ] Review low-performing pages
- [ ] Review GBP insights
- [ ] Check reviews and rating count
- [ ] Crawl site for broken links
- [ ] Check page speed on top pages
- [ ] Refresh outdated service content
- [ ] Add new photos/projects
- [ ] Add FAQs based on real customer questions
- [ ] Check competitor pages
- [ ] Check NAP consistency
- [ ] Check if new service pages are needed
- [ ] Check if location pages are needed
- [ ] Review conversion tracking

-----

## Recommended Audit Tools

Free or mostly free:

- Google Search Console
- Bing Webmaster Tools
- Ahrefs Webmaster Tools
- PageSpeed Insights
- Lighthouse
- Screaming Frog SEO Spider (free crawl up to 500 URLs)
- Google Rich Results Test
- Google Business Profile
- Apple Business Connect