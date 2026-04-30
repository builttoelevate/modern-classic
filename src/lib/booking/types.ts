// Shared types between the wizard UI and the booking API endpoint.
// Anything that crosses the wire goes here.

export interface WizardServicePayload {
  variationId: string;
  version: number;
  durationMinutes: number;
  name: string;
  priceDisplay: string;
}

export interface WizardBarberPayload {
  id: string;
  name: string;
}

export interface WizardSlotPayload {
  startAtUtc: string;
}

export interface WizardCustomerPayload {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  note?: string;
  /**
   * If true, the API may overwrite the existing Square customer record's
   * phone or name with the values supplied here. Default false (do not
   * overwrite). Only relevant for returning customers.
   */
  updateContact?: boolean;
}

export interface CreateBookingRequest {
  service: WizardServicePayload;
  barber: WizardBarberPayload;
  slot: WizardSlotPayload;
  customer: WizardCustomerPayload;
}

export interface CreateBookingSuccess {
  ok: true;
  bookingId: string;
  customerId: string;
  startAtUtc: string;
}

export interface CreateBookingFailure {
  ok: false;
  error: {
    code: string;
    detail: string;
    /** When non-null, the slot the user picked is no longer available. */
    slotTaken?: boolean;
    /** When non-null, the slot is too soon under Michael's lead-time policy. */
    leadTimeTooShort?: boolean;
    /** Existing record info for returning customers, surfaced for UX nudges. */
    existingCustomer?: {
      givenName?: string;
      familyName?: string;
      phone?: string;
    };
  };
}

export type CreateBookingResponse = CreateBookingSuccess | CreateBookingFailure;

export function priceDisplay(
  minCents: number | null,
  maxCents: number | null,
  pricingType: 'FIXED_PRICING' | 'VARIABLE_PRICING',
): string {
  if (pricingType === 'VARIABLE_PRICING' || minCents === null || maxCents === null) {
    if (minCents !== null && maxCents !== null && minCents !== maxCents) {
      return `$${(minCents / 100).toFixed(0)}–$${(maxCents / 100).toFixed(0)}`;
    }
    return 'Variable';
  }
  if (minCents === maxCents) return `$${(minCents / 100).toFixed(0)}`;
  return `$${(minCents / 100).toFixed(0)}–$${(maxCents / 100).toFixed(0)}`;
}
