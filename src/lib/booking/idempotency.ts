import { createHash } from 'node:crypto';

// Deterministic idempotency key — same email + slot + variation always
// hashes to the same value. If the user double-clicks Confirm, Square
// returns the existing booking instead of creating a duplicate.
//
// Key length: SHA-256 hex is 64 chars; Square allows up to 192 chars.
export function bookingIdempotencyKey(input: {
  email: string;
  startAtUtc: string;
  serviceVariationId: string;
}): string {
  const h = createHash('sha256');
  h.update(input.email.trim().toLowerCase());
  h.update('|');
  h.update(input.startAtUtc);
  h.update('|');
  h.update(input.serviceVariationId);
  return `mc-${h.digest('hex')}`;
}
