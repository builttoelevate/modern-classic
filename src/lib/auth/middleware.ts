// Phase 5 Part A — auth middleware helpers.
//
// Used by every server endpoint and the my-bookings page. getSession reads
// the cookie and returns the verified payload (or null). requireSession is
// the strict version — throws a 401 Response when unauthenticated, so the
// endpoint can `try { const s = requireSession(req) } catch (r) { return r }`.
//
// Sliding refresh: the page/endpoint reissues the cookie on every authed
// request via buildSessionCookie(signSession(payload)).

import {
  buildSessionCookie,
  readSessionCookie,
  signSession,
  verifySession,
  type SessionPayload,
} from './session';

export type Session = SessionPayload;

export function getSession(request: Request): Session | null {
  const token = readSessionCookie(request);
  if (!token) return null;
  return verifySession(token);
}

export class AuthRequiredError extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super('AuthRequired');
    this.response = response;
  }
}

export function requireSession(request: Request): Session {
  const session = getSession(request);
  if (!session) {
    throw new AuthRequiredError(
      Response.json(
        { ok: false, error: { code: 'UNAUTHENTICATED', detail: 'Sign in required.' } },
        { status: 401 },
      ),
    );
  }
  return session;
}

/**
 * Cookie value for sliding-refresh. Call this on any authenticated response
 * to give the user a fresh 90-day window.
 */
export function refreshSessionCookie(session: Session): string {
  return buildSessionCookie(signSession(session));
}
