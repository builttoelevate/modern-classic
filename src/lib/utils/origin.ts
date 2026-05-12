// Resolve the public origin of the request — the URL the customer
// actually typed in their browser, NOT Vercel's internal lambda
// host. Used by every server endpoint that builds outbound links
// (review-request emails, magic-link sign-in emails, family invite
// emails) so the URL the user clicks resolves to the deployed
// domain instead of `http://localhost`.
//
// Why this exists: on Vercel's serverless runtime, parsing
// `request.url` gives back the function's internal URL — typically
// `http://localhost/...`. The customer-facing origin lives in the
// `x-forwarded-proto` + `x-forwarded-host` headers Vercel sets on
// every incoming request, including cron invocations.
//
// Order of preference:
//   1. SITE_URL env var, if set (lets us override the public origin
//      explicitly — useful for preview environments that need a
//      pinned canonical domain).
//   2. x-forwarded-proto + x-forwarded-host (Vercel + most reverse
//      proxies set these to the public hostname the user hit).
//   3. plain `host` header.
//   4. `request.url` parse (works locally with `astro dev`).
//   5. Hardcoded production fallback so emails never go out with
//      a broken link even if every other lookup fails.

const FALLBACK_ORIGIN = 'https://mdrnclassic.com';

export function getPublicOrigin(request: Request): string {
  const env = import.meta.env.SITE_URL;
  if (typeof env === 'string' && /^https?:\/\//i.test(env)) {
    return env.replace(/\/$/, '');
  }
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  try {
    const url = new URL(request.url);
    // Reject the well-known broken case — `request.url` on Vercel
    // serverless lambdas often parses to a localhost host. Fall
    // through to the canonical fallback rather than minting a link
    // we know is dead.
    if (url.host && !/^localhost(:|$)/i.test(url.host)) {
      return `${url.protocol}//${url.host}`.replace(/\/$/, '');
    }
  } catch {
    // Fall through.
  }
  return FALLBACK_ORIGIN;
}
