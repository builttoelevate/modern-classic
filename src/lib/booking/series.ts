// Book Ahead — series id and customer-note prefix.
//
// Pure data-layer hooks. The customer picks each visit by hand
// from the live calendar (no auto-generated cadence), so the
// only thing this module owns is the linking thread that lets a
// future admin "view all bookings in this series" or "cancel
// whole series" feature stitch them back together. Mirrors the
// mc-grp- / Group [mc-grp-...] pattern used for group bookings.

/**
 * Generate a series id. Stamped on every booking made in one
 * Book Ahead session via buildSeriesNote.
 */
export function newSeriesId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `mc-srs-${hex}`;
}

/**
 * Build the customer-note prefix for a single visit in a series.
 * Format mirrors the group preamble so the same admin/log
 * parsers can recognize the pattern:
 *
 *   Series [mc-srs-a1b2c3d4] · 3/4
 *   Note: Customer's typed note     ← only on the first visit
 *
 * No cadence field — the multi-pick model has no inherent
 * frequency. Customers never see the prefix; getCustomerBookings
 * strips it from the displayed customer note (parallel to how
 * group preambles are stripped).
 */
export function buildSeriesNote(input: {
  seriesId: string;
  position: number;
  total: number;
  userNote?: string;
}): string {
  const head = `Series [${input.seriesId}] · ${input.position}/${input.total}`;
  const trimmedUserNote = input.userNote?.trim();
  return trimmedUserNote ? `${head}\nNote: ${trimmedUserNote}` : head;
}
