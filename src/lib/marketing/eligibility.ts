// Single eligibility gate for every email we send to customers.
//
// CAN-SPAM (and most GDPR-style frameworks) split into two categories:
//   - TRANSACTIONAL / RELATIONSHIP messages — confirmations, post-visit
//     review requests, anything tied directly to a service the customer
//     already purchased. These do NOT require marketing opt-in; the
//     customer can still bail via a per-channel unsubscribe link.
//   - COMMERCIAL / MARKETING messages — newsletters, promos, holiday
//     offers. These require explicit opt-in (marketing_consent) and
//     honor the broader marketing-unsubscribe flag.
//
// Bypassing these helpers risks emailing people who never opted in or
// who already unsubscribed. Always route new email types through one of
// the two functions below.

import type { Customer } from '../square/types';
import type { MarketingAttributes } from '../square/customAttributes';

export interface EligibilityInput {
  customer: Customer;
  marketingAttributes: MarketingAttributes;
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;

function hasValidEmail(customer: Customer): boolean {
  const email = (customer.email_address ?? '').trim();
  if (!email) return false;
  return EMAIL_RE.test(email);
}

/** True when the customer has explicitly opted in to MARKETING emails
 *  (offers, newsletters, etc.) and hasn't unsubscribed since. Used by
 *  promotional email paths only — NOT by post-visit review requests
 *  (see isEligibleForReviewRequest). */
export function isOptedInForMarketing(input: EligibilityInput): boolean {
  const { customer, marketingAttributes } = input;

  if (marketingAttributes.consent !== true) return false;
  if (marketingAttributes.unsubscribedAt && marketingAttributes.unsubscribedAt.trim() !== '') {
    return false;
  }
  if (customer.preferences?.email_unsubscribed === true) return false;
  if (!hasValidEmail(customer)) return false;

  return true;
}

/** True when the customer should receive a post-visit review request.
 *  Defaults to ON — review requests are transactional (CAN-SPAM
 *  relationship messages), so we don't require marketing opt-in. We
 *  do honor three opt-out signals:
 *
 *   1. `review_requests_unsubscribed_at` — set when they click the
 *      unsubscribe link in a review-request email specifically.
 *   2. Square's native `email_unsubscribed` flag on the customer
 *      record — a clear global "stop emailing me" signal that should
 *      override transactional defaults.
 *   3. No valid email on file. */
export function isEligibleForReviewRequest(input: EligibilityInput): boolean {
  const { customer, marketingAttributes } = input;

  if (
    marketingAttributes.reviewRequestsUnsubscribedAt &&
    marketingAttributes.reviewRequestsUnsubscribedAt.trim() !== ''
  ) {
    return false;
  }
  if (customer.preferences?.email_unsubscribed === true) return false;
  if (!hasValidEmail(customer)) return false;

  return true;
}
