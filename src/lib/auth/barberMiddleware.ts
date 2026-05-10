// Auth middleware for the barber dashboard. Mirrors the customer-side
// middleware.ts but reads/writes the barber-specific cookie.

import {
  buildBarberSessionCookie,
  readBarberSessionCookie,
  signBarberSession,
  verifyBarberSession,
  type BarberSessionPayload,
} from './barberSession';

export type BarberSession = BarberSessionPayload;

export function getBarberSession(request: Request): BarberSession | null {
  const token = readBarberSessionCookie(request);
  if (!token) return null;
  return verifyBarberSession(token);
}

export class BarberAuthRequiredError extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super('BarberAuthRequired');
    this.response = response;
  }
}

export function requireBarberSession(request: Request): BarberSession {
  const session = getBarberSession(request);
  if (!session) {
    throw new BarberAuthRequiredError(
      Response.json(
        { ok: false, error: { code: 'UNAUTHENTICATED', detail: 'Barber sign-in required.' } },
        { status: 401 },
      ),
    );
  }
  return session;
}

/** Sliding refresh — call on any authed response to extend the window. */
export function refreshBarberSessionCookie(session: BarberSession): string {
  return buildBarberSessionCookie(signBarberSession(session));
}
