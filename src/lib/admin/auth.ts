// Admin access gate. Two paths in:
//
//   1. HTTP Basic Auth (the original). Username fixed at "admin",
//      password from ADMIN_PASSWORD env var. Used by Bill on desktop
//      via the browser's saved password.
//   2. An owner barber session (the May 2026 addition). If the request
//      carries a valid `mc_barber_session` cookie AND the signed-in
//      barber's team_member_id matches an Owner entry in ROLE_BY_ID,
//      we accept the request without prompting for Basic Auth.
//      This is the "Admin" link on the barber dashboard — Michael
//      taps it from his phone and lands on /admin without retyping
//      anything. Master Barbers (Rick, Clayton) are NOT in the
//      Owner set, so their sessions still get the Basic Auth prompt.
//
// Why owner sessions are at least as trustworthy as Basic Auth:
// the session cookie is HMAC-signed (AUTH_SECRET) and tied to a
// per-barber Redis-backed account with its own password. A barber
// can only get an owner session by signing into the barber portal
// AND being mapped to 'Owner' in src/lib/square/team.ts. The admin
// password is a shared secret; the owner-session path is in fact
// tighter — it identifies a specific human, not "whoever has the
// password."

import { OWNER_TEAM_MEMBER_IDS } from '../square/team';
import {
  readBarberSessionCookie,
  verifyBarberSession,
} from '../auth/barberSession';
import {
  buildAdminSessionCookie,
  readAdminSessionCookie,
  signAdminSession,
  verifyAdminSession,
} from './adminSession';

const REALM = 'Modern Classic Admin';

export interface AuthResult {
  ok: boolean;
  /** A 401 Response to return when ok=false. */
  challenge: Response;
  /** Present only when the request authenticated via the Basic Auth
   *  header on a page load — a freshly-minted Set-Cookie string for the
   *  short-lived admin session cookie. Admin pages append this to their
   *  response so subsequent fetch() actions (which iPhone Safari won't
   *  re-send Basic Auth on) authenticate via the cookie instead. */
  refreshCookie?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Returns true iff the request carries a signed barber session
 *  whose barberId is mapped to the Owner role. Sync — uses the
 *  hardcoded OWNER_TEAM_MEMBER_IDS set, no Square round-trip. */
function hasOwnerBarberSession(request: Request): boolean {
  const token = readBarberSessionCookie(request);
  if (!token) return false;
  const session = verifyBarberSession(token);
  if (!session) return false;
  return OWNER_TEAM_MEMBER_IDS.has(session.barberId);
}

export function checkBasicAuth(request: Request): AuthResult {
  const expected = import.meta.env.ADMIN_PASSWORD;
  const challenge = new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain',
    },
  });

  if (!expected || typeof expected !== 'string') {
    // No password configured — refuse access entirely so we never expose
    // logs from a misconfigured deploy.
    return {
      ok: false,
      challenge: new Response('Admin not configured (set ADMIN_PASSWORD)', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
    };
  }

  // Path: owner barber session. Checked first because if Michael's
  // already signed into the barber portal we should let him through
  // without ever surfacing the Basic Auth prompt.
  if (hasOwnerBarberSession(request)) {
    return { ok: true, challenge };
  }

  // Path: HTTP Basic Auth header. Checked before the admin-session
  // cookie so that every page navigation (where the browser DOES send
  // the saved password) re-mints a fresh cookie — a sliding 12h window
  // that won't expire mid-session. On success we hand back a
  // refreshCookie the page appends; that cookie is what carries the
  // fetch() button actions on iPhone Safari, which won't re-send Basic
  // Auth on its own.
  const header = request.headers.get('authorization');
  if (header && header.toLowerCase().startsWith('basic ')) {
    let decoded: string;
    try {
      decoded = atob(header.slice(6).trim());
    } catch {
      return { ok: false, challenge };
    }
    const sep = decoded.indexOf(':');
    if (sep < 0) return { ok: false, challenge };
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user !== 'admin') return { ok: false, challenge };
    if (!timingSafeEqual(pass, expected)) return { ok: false, challenge };
    // Mint the session cookie best-effort — if AUTH_SECRET is unset the
    // signer throws; fall back to plain Basic-Auth-only behavior rather
    // than 500 the admin page.
    let refreshCookie: string | undefined;
    try {
      refreshCookie = buildAdminSessionCookie(signAdminSession());
    } catch {
      refreshCookie = undefined;
    }
    return { ok: true, challenge, refreshCookie };
  }

  // Path: admin-session cookie. This is the one that authenticates the
  // background fetch() requests (Block/Remove/etc.) on mobile, where
  // the Basic Auth header isn't re-sent.
  const adminToken = readAdminSessionCookie(request);
  if (adminToken && verifyAdminSession(adminToken)) {
    return { ok: true, challenge };
  }

  return { ok: false, challenge };
}
