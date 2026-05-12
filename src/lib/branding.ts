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

/** Phone the customer is told to call when something can't be
 *  completed online (e.g. blocked-from-booking refusal). */
export const SHOP_PHONE = '740-297-4462';

/** Single global namespace for every Redis key written by code
 *  introduced from PR 2 onward. Existing modules (cardIndex,
 *  profileLinks, waitlistLog, etc.) still hardcode 'mc:' and aren't
 *  retrofitted here — that's a separate hygiene PR. */
export const REDIS_KEY_PREFIX = 'mc';
