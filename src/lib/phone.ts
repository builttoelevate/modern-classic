// Shared phone-number normalization. Was previously private to
// src/lib/square/customers.ts; extracted so admin features
// (blocked-customers list, etc.) can use the same canonical form
// that find-or-create-customer writes into Square.
//
// Accepts any reasonable US input — "740-297-4462", "(740) 297-4462",
// "+17402974462", etc. — and returns E.164 ("+17402974462") so every
// downstream lookup keys off the same string.

export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  // Square accepts E.164. Default to US (+1) if missing.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return input;
}
