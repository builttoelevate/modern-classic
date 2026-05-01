// Phase 7 — single eligibility gate for every marketing email we send.
//
// Future phases (rebook reminders, birthday/lifecycle, etc.) MUST go
// through this helper before calling Resend. Bypassing it risks emailing
// people who never opted in or who already unsubscribed.

import type { Customer } from '../square/types';
import type { MarketingAttributes } from '../square/customAttributes';

export interface EligibilityInput {
  customer: Customer;
  marketingAttributes: MarketingAttributes;
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;

export function isOptedInForMarketing(input: EligibilityInput): boolean {
  const { customer, marketingAttributes } = input;

  if (marketingAttributes.consent !== true) return false;
  if (marketingAttributes.unsubscribedAt && marketingAttributes.unsubscribedAt.trim() !== '') {
    return false;
  }
  if (customer.preferences?.email_unsubscribed === true) return false;

  const email = (customer.email_address ?? '').trim();
  if (!email) return false;
  if (!EMAIL_RE.test(email)) return false;

  return true;
}
