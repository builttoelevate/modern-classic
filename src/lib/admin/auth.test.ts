// Unit tests for the admin auth gate. Two paths in:
//   1. HTTP Basic Auth (the original; admin password)
//   2. Owner barber session (the May 2026 addition; Michael's session)
//
// Both paths must work; non-owner barber sessions must fall through
// to Basic Auth (not bypass it).

import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('ADMIN_PASSWORD', 'admin-pass-12345');
vi.stubEnv(
  'AUTH_SECRET',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
);

import { checkBasicAuth } from './auth';
import {
  BARBER_SESSION_COOKIE_NAME,
  signBarberSession,
} from '../auth/barberSession';
import {
  ADMIN_SESSION_COOKIE_NAME,
  signAdminSession,
} from './adminSession';

// Owner team_member_id from src/lib/square/team.ts — Michael.
const OWNER_ID = '523GMGEC1FY0Z';
// One of the Master Barber ids from the same file — Rick / Clayton.
const REGULAR_BARBER_ID = 'TMZ4GRNFpRhnzLbv';

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request('https://example.test/admin', { headers });
}

function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function cookieHeader(token: string): string {
  return `${BARBER_SESSION_COOKIE_NAME}=${token}`;
}

describe('checkBasicAuth — HTTP Basic Auth path (regression)', () => {
  it('returns ok on correct admin password', () => {
    const req = reqWithHeaders({
      authorization: basicAuthHeader('admin', 'admin-pass-12345'),
    });
    expect(checkBasicAuth(req).ok).toBe(true);
  });

  it('returns 401 on wrong password', () => {
    const req = reqWithHeaders({
      authorization: basicAuthHeader('admin', 'wrong'),
    });
    const result = checkBasicAuth(req);
    expect(result.ok).toBe(false);
    expect(result.challenge.status).toBe(401);
  });

  it('returns 401 on wrong username even with correct password', () => {
    const req = reqWithHeaders({
      authorization: basicAuthHeader('michael', 'admin-pass-12345'),
    });
    expect(checkBasicAuth(req).ok).toBe(false);
  });

  it('returns 401 on missing Authorization header', () => {
    const req = reqWithHeaders({});
    expect(checkBasicAuth(req).ok).toBe(false);
  });
});

describe('checkBasicAuth — owner barber session path', () => {
  it('returns ok when the request carries a valid owner session cookie', () => {
    const token = signBarberSession({ barberId: OWNER_ID, username: 'michael' });
    const req = reqWithHeaders({ cookie: cookieHeader(token) });
    expect(checkBasicAuth(req).ok).toBe(true);
  });

  it('returns 401 when the session belongs to a non-owner barber', () => {
    const token = signBarberSession({
      barberId: REGULAR_BARBER_ID,
      username: 'rick',
    });
    const req = reqWithHeaders({ cookie: cookieHeader(token) });
    const result = checkBasicAuth(req);
    expect(result.ok).toBe(false);
    expect(result.challenge.status).toBe(401);
  });

  it('returns 401 when the session token is tampered with', () => {
    const token = signBarberSession({ barberId: OWNER_ID, username: 'michael' });
    // Flip a char in the signature portion.
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    const req = reqWithHeaders({ cookie: cookieHeader(tampered) });
    expect(checkBasicAuth(req).ok).toBe(false);
  });

  it('returns 401 when there is no session cookie AND no Basic Auth', () => {
    const req = reqWithHeaders({ cookie: 'unrelated=value' });
    expect(checkBasicAuth(req).ok).toBe(false);
  });

  it('owner session works EVEN WITHOUT any Authorization header', () => {
    // Regression of the whole point — Michael taps the Admin link
    // from his barber dashboard, his browser sends only the cookie,
    // no WWW-Authenticate prompt should surface.
    const token = signBarberSession({ barberId: OWNER_ID, username: 'michael' });
    const req = reqWithHeaders({ cookie: cookieHeader(token) });
    expect(checkBasicAuth(req).ok).toBe(true);
  });

  it('non-owner session does NOT bypass Basic Auth — falls through to it', () => {
    // Rick has a session AND happens to also be sending the admin
    // password (unusual but possible). The owner check fails, falls
    // through to Basic Auth which succeeds.
    const token = signBarberSession({
      barberId: REGULAR_BARBER_ID,
      username: 'rick',
    });
    const req = reqWithHeaders({
      cookie: cookieHeader(token),
      authorization: basicAuthHeader('admin', 'admin-pass-12345'),
    });
    expect(checkBasicAuth(req).ok).toBe(true);
  });
});

describe('checkBasicAuth — admin session cookie path (mobile fetch fix)', () => {
  it('mints a refreshCookie on a successful Basic Auth page load', () => {
    const req = reqWithHeaders({
      authorization: basicAuthHeader('admin', 'admin-pass-12345'),
    });
    const result = checkBasicAuth(req);
    expect(result.ok).toBe(true);
    expect(result.refreshCookie).toBeTruthy();
    expect(result.refreshCookie).toContain(`${ADMIN_SESSION_COOKIE_NAME}=`);
    // Cookie hardening attributes must be present.
    expect(result.refreshCookie).toContain('HttpOnly');
    expect(result.refreshCookie).toContain('Secure');
    expect(result.refreshCookie).toContain('SameSite=Lax');
  });

  it('authenticates a request carrying only a valid admin session cookie', () => {
    // The whole point: a background fetch() with no Basic Auth header
    // (iPhone Safari) still authenticates via the cookie.
    const token = signAdminSession();
    const req = reqWithHeaders({
      cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
    });
    const result = checkBasicAuth(req);
    expect(result.ok).toBe(true);
    // No Basic Auth header on this request, so nothing to re-mint.
    expect(result.refreshCookie).toBeUndefined();
  });

  it('rejects a tampered admin session cookie', () => {
    const token = signAdminSession();
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    const req = reqWithHeaders({
      cookie: `${ADMIN_SESSION_COOKIE_NAME}=${tampered}`,
    });
    const result = checkBasicAuth(req);
    expect(result.ok).toBe(false);
    expect(result.challenge.status).toBe(401);
  });

  it('rejects an expired admin session cookie', () => {
    // Negative duration → already expired.
    const token = signAdminSession(-1);
    const req = reqWithHeaders({
      cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
    });
    expect(checkBasicAuth(req).ok).toBe(false);
  });
});
