// Tiny HTTP Basic Auth helper for the admin dashboard. Username is fixed
// at "admin" and the password is read from the ADMIN_PASSWORD env var.
//
// We intentionally use Basic Auth instead of building a session/login flow:
// this is for one trusted user (Bill / Michael), not for end customers.

const REALM = 'Modern Classic Admin';

export interface AuthResult {
  ok: boolean;
  /** A 401 Response to return when ok=false. */
  challenge: Response;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
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

  const header = request.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('basic ')) {
    return { ok: false, challenge };
  }

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
  return { ok: true, challenge };
}
