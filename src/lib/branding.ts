// Shop identity and Redis key prefix. Tightly scoped — this is NOT a
// general config drawer. The intent is to give a future tenant
// abstraction (if one ever lands) exactly one substitution point.
//
// Today the codebase is single-tenant: every Vercel deploy serves
// Modern Classic. If a second shop ever onboards onto this codebase,
// these constants become a runtime resolver (request → tenant config).

/** Display name. Admin pages may surface this; customer-facing copy
 *  generally doesn't need it. */
export const SHOP_NAME = 'Modern Classic Barbershop';

/** Shop phone — used for barber-facing emails and admin diagnostics ONLY.
 *  Do NOT render to customers in any flow: booking confirmations,
 *  customer emails, /my-bookings, /cancellation-policy, sign-in errors,
 *  etc. Customer-facing surfaces direct people to /my-bookings for
 *  self-service or to SHOP_EMAIL for the rare case where they're stuck.
 *  Bill's directive: minimize inbound calls during the day. */
export const SHOP_PHONE = '740-297-4462';

/** Shop email — the customer-facing fallback when /my-bookings
 *  self-service isn't enough. Goes to the shop's ProtonMail, which the
 *  team monitors during the day. */
export const SHOP_EMAIL = 'modernclassicbarbershop@protonmail.com';

/** Single global namespace for every Redis key written by code
 *  introduced from PR 2 onward. Existing modules (cardIndex,
 *  profileLinks, waitlistLog, etc.) still hardcode 'mc:' and aren't
 *  retrofitted here — that's a separate hygiene PR. */
export const REDIS_KEY_PREFIX = 'mc';
