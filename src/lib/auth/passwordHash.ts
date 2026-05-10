// Password hashing for barber accounts.
//
// Uses Node's built-in scrypt (no new deps). Format stored in KV:
//   scrypt$<saltHex>$<hashHex>
//
// Verify is timing-safe. Hash length is 64 bytes, salt is 16 bytes.
// Cost params are scrypt's defaults bumped to N=16384, r=8, p=1, which
// matches OWASP's current minimum for interactive logins.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCHEME = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: empty password');
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plain, salt);
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;
  let saltBuf: Buffer;
  let keyBuf: Buffer;
  try {
    saltBuf = Buffer.from(parts[1], 'hex');
    keyBuf = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (saltBuf.length !== SALT_BYTES || keyBuf.length !== KEY_BYTES) return false;
  let candidate: Buffer;
  try {
    candidate = await scryptAsync(plain, saltBuf);
  } catch {
    return false;
  }
  if (candidate.length !== keyBuf.length) return false;
  return timingSafeEqual(candidate, keyBuf);
}

/** Generate a random alphanumeric password of the requested length.
 *  Used when an admin provisions a new barber or resets a password —
 *  the plaintext is shown once in the admin UI for handoff. Excludes
 *  visually-ambiguous characters (0/O, 1/l/I) to make manual entry
 *  less error-prone. */
export function generateDefaultPassword(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
