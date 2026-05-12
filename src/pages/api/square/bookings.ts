import type { APIRoute } from 'astro';
import { SquareApiError } from '../../../lib/square/client';
import { findOrCreateCustomer, getCustomerById, type MarketingConsentDecision } from '../../../lib/square/customers';
import { isPhoneBlocked } from '../../../lib/customer/blockedCustomers';
import { createBooking } from '../../../lib/square/bookings';
import { bookingIdempotencyKey } from '../../../lib/booking/idempotency';
import { customerInitials, logBooking, redactEmail } from '../../../lib/booking/log';
import { getSession } from '../../../lib/auth/middleware';
import { listLinkedPeople } from '../../../lib/customer/profileLinks';
import { createBookingCardRecord } from '../../../lib/booking/cardIndex';
import { getCard } from '../../../lib/square/cards';
import type {
  CreateBookingFailure,
  CreateBookingRequest,
  CreateBookingResponse,
  CreateBookingSuccess,
} from '../../../lib/booking/types';

export const prerender = false;

function fail(
  status: number,
  code: string,
  detail: string,
  extra?: Partial<CreateBookingFailure['error']>,
): Response {
  const body: CreateBookingFailure = {
    ok: false,
    error: { code, detail, ...(extra ?? {}) },
  };
  return Response.json(body satisfies CreateBookingResponse, { status });
}

function classifySquareError(err: SquareApiError): {
  status: number;
  code: string;
  detail: string;
  slotTaken?: boolean;
  leadTimeTooShort?: boolean;
} {
  // Rough classification — Square doesn't return a single canonical "slot
  // taken" code, but the patterns below cover the practical cases.
  const msg = `${err.code} ${err.detail}`.toLowerCase();
  if (
    err.code === 'BOOKING_CONFLICT' ||
    err.code === 'TIME_CONFLICT' ||
    err.code === 'BOOKING_TIME_NOT_AVAILABLE' ||
    /already.*book|conflict|not available|overlap/.test(msg)
  ) {
    return {
      status: 409,
      code: err.code,
      detail: 'That slot was just taken — please pick another.',
      slotTaken: true,
    };
  }
  if (
    err.code === 'INVALID_TIME' ||
    err.code === 'BOOKING_TIME_TOO_EARLY' ||
    /too soon|too early|lead time/.test(msg)
  ) {
    return {
      status: 422,
      code: err.code,
      detail: "Sorry, that's too soon — please pick a later time.",
      leadTimeTooShort: true,
    };
  }
  if (err.code === 'AUTHENTICATION_ERROR' || err.code === 'UNAUTHORIZED') {
    return {
      status: 502,
      code: err.code,
      detail: 'Booking system is temporarily unavailable.',
    };
  }
  return {
    status: err.status >= 400 && err.status < 600 ? err.status : 502,
    code: err.code,
    detail: err.detail || 'Square returned an error.',
  };
}

function validate(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'Payload must be an object';
  const r = p as Partial<CreateBookingRequest>;
  if (!r.service?.variationId) return 'service.variationId is required';
  if (typeof r.service?.version !== 'number') return 'service.version is required';
  if (typeof r.service?.durationMinutes !== 'number') return 'service.durationMinutes is required';
  if (!r.barber?.id) return 'barber.id is required';
  if (!r.slot?.startAtUtc) return 'slot.startAtUtc is required';
  if (isNaN(new Date(r.slot.startAtUtc).getTime())) return 'slot.startAtUtc must be a valid ISO date';
  if (!r.customer?.givenName?.trim()) return 'customer.givenName is required';
  if (!r.customer?.familyName?.trim()) return 'customer.familyName is required';
  if (!r.customer?.email?.trim()) return 'customer.email is required';
  if (!/^\S+@\S+\.\S+$/.test(r.customer.email.trim())) return 'customer.email is not a valid email';
  if (!r.customer?.phone) return 'customer.phone is required';
  if (r.customer.phone.replace(/\D/g, '').length < 10) return 'customer.phone must be 10 digits';
  if (r.customer.note && r.customer.note.length > 500) return 'customer.note exceeds 500 chars';
  return null;
}

export const POST: APIRoute = async ({ request }) => {
  const startedAt = Date.now();
  let attemptId = 'unknown';
  if (typeof crypto?.randomUUID === 'function') {
    attemptId = crypto.randomUUID();
  } else {
    attemptId = `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  let payload: CreateBookingRequest;
  try {
    payload = (await request.json()) as CreateBookingRequest;
  } catch {
    logBooking({ phase: 'validation-failed', attemptId, errorDetail: 'invalid JSON' });
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON');
  }

  const validationErr = validate(payload);
  if (validationErr) {
    logBooking({
      phase: 'validation-failed',
      attemptId,
      customerEmail: redactEmail(payload?.customer?.email),
      errorDetail: validationErr,
    });
    return fail(400, 'BAD_REQUEST', validationErr);
  }

  const initials = customerInitials(payload.customer.givenName, payload.customer.familyName);
  logBooking({
    phase: 'request-received',
    attemptId,
    customerEmail: redactEmail(payload.customer.email),
    customerInitials: initials,
    service: payload.service.name,
    startAtUtc: payload.slot.startAtUtc,
  });

  const idempotencyKey = bookingIdempotencyKey({
    email: payload.customer.email,
    startAtUtc: payload.slot.startAtUtc,
    serviceVariationId: payload.service.variationId,
  });

  const session = getSession(request);

  try {
    // Resolve the Square customer_id, in priority order:
    //   1. existingCustomerId  — "Booking for" (parent → linked person).
    //   2. session.customerId  — signed-in customer; the session is the
    //      source of truth, NOT the typed email. A one-character email
    //      typo on Step 4 used to find-or-create a brand-new Square
    //      record, which silently split bookings off the real customer
    //      (no SMS opt-in, missing from /my-bookings).
    //   3. findOrCreateCustomer — true guest checkout, match-by-email.
    let resolvedCustomerId: string;
    // Stored phone on the resolved Square customer record (E.164-ish,
    // whatever Square has on file). Used for the block-list check
    // ALONGSIDE the typed Step-4 phone, so a blocked person can't
    // slip through by signing in with their account and typing a
    // different number at Step 4.
    let resolvedPhone: string | undefined;
    // Promise carrying the eventual marketing-consent decision. Resolves
    // immediately to a noop for branches that don't apply consent (we
    // only collect it in the guest checkout / new-customer paths). We
    // race this against createBooking() so the response is ready as soon
    // as Square confirms the booking — no waiting on the slower CA API.
    let marketingDecisionPromise: Promise<MarketingConsentDecision> = Promise.resolve({
      kind: 'noop',
      reason: 'no-signal',
    });
    if (payload.existingCustomerId && payload.existingCustomerId.trim().length > 0) {
      const requestedId = payload.existingCustomerId.trim();
      // existingCustomerId is reserved for the "Booking for" feature
      // (parent booking on behalf of a linked person). It REQUIRES a
      // session and the requested id MUST belong to the signed-in
      // customer themselves OR to one of their linked people. Without
      // this, an unauthenticated guest could supply any known Square
      // customer id and book under it.
      if (!session) {
        return fail(401, 'UNAUTHENTICATED', 'Booking under an existing customer requires sign-in.');
      }
      let permitted = requestedId === session.customerId;
      if (!permitted) {
        try {
          const linked = await listLinkedPeople(session.customerId);
          permitted = linked.some((p) => p.customerId === requestedId);
        } catch {
          // KV outage — refuse rather than leak booking rights on a
          // transient failure. The signed-in customer can retry.
          permitted = false;
        }
      }
      if (!permitted) {
        logBooking({
          phase: 'existing-customer-forbidden',
          attemptId,
          customerInitials: initials,
          customerId: requestedId,
        });
        return fail(
          403,
          'FORBIDDEN',
          'You can only book under your own account or a linked person on your profile.',
        );
      }
      const verified = await getCustomerById(requestedId);
      if (!verified) {
        return Response.json(
          {
            ok: false,
            error: { code: 'CUSTOMER_NOT_FOUND', detail: 'Booking-for record not found.' },
          } satisfies CreateBookingFailure,
          { status: 400 },
        );
      }
      resolvedCustomerId = verified.id;
      resolvedPhone = verified.phone_number;
      logBooking({
        phase: 'use-existing-customer',
        attemptId,
        customerInitials: initials,
        customerId: resolvedCustomerId,
      });
    } else if (session) {
      const verified = await getCustomerById(session.customerId);
      if (verified) {
        resolvedCustomerId = verified.id;
        resolvedPhone = verified.phone_number;
        logBooking({
          phase: 'use-session-customer',
          attemptId,
          customerInitials: initials,
          customerId: resolvedCustomerId,
        });
      } else {
        // Session points at a customer Square no longer has (deleted /
        // merged out from under us). Fall through to find-or-create so
        // the booking still completes rather than 4xx'ing the user.
        const findOrCreate = await findOrCreateCustomer({
          givenName: payload.customer.givenName.trim(),
          familyName: payload.customer.familyName.trim(),
          email: payload.customer.email.trim().toLowerCase(),
          phone: payload.customer.phone,
          updateContact: payload.customer.updateContact ?? false,
          marketingConsent: payload.customer.marketingConsent === true,
          marketingConsentSource: 'booking_flow_step_4',
        });
        resolvedCustomerId = findOrCreate.customer.id;
        resolvedPhone = findOrCreate.customer.phone_number;
        marketingDecisionPromise = findOrCreate.marketingDecisionPromise;
        logBooking({
          phase: 'session-customer-missing-fallback',
          attemptId,
          customerEmail: redactEmail(payload.customer.email),
          customerInitials: initials,
          customerId: resolvedCustomerId,
        });
      }
    } else {
      const findOrCreate = await findOrCreateCustomer({
        givenName: payload.customer.givenName.trim(),
        familyName: payload.customer.familyName.trim(),
        email: payload.customer.email.trim().toLowerCase(),
        phone: payload.customer.phone,
        updateContact: payload.customer.updateContact ?? false,
        marketingConsent: payload.customer.marketingConsent === true,
        marketingConsentSource: 'booking_flow_step_4',
      });
      resolvedCustomerId = findOrCreate.customer.id;
      resolvedPhone = findOrCreate.customer.phone_number;
      marketingDecisionPromise = findOrCreate.marketingDecisionPromise;

      logBooking({
        phase: 'find-or-create-customer',
        attemptId,
        customerEmail: redactEmail(payload.customer.email),
        customerInitials: initials,
        customerId: resolvedCustomerId,
        marketingConsent: payload.customer.marketingConsent === true,
      });
    }

    // Block-from-booking enforcement. Square's per-customer "Block
    // from booking" toggle is enforced only on Square's own hosted
    // booking page; the flag isn't exposed on the public API. We
    // maintain our own phone-keyed list in Upstash Redis. See
    // src/lib/customer/blockedCustomers.ts.
    //
    // Check BOTH the typed Step-4 phone and the resolved customer's
    // stored phone — closes the case where a blocked person signs in
    // with their account (session.customerId → blocked record) but
    // types a different number on Step 4.
    const phonesToCheck = [payload.customer.phone];
    if (resolvedPhone && resolvedPhone !== payload.customer.phone) {
      phonesToCheck.push(resolvedPhone);
    }
    const blockChecks = await Promise.all(phonesToCheck.map(isPhoneBlocked));
    if (blockChecks.some(Boolean)) {
      logBooking({
        phase: 'blocked-customer-refused',
        attemptId,
        customerEmail: redactEmail(payload.customer.email),
        customerInitials: initials,
        customerId: resolvedCustomerId,
        durationMs: Date.now() - startedAt,
      });
      // Generic message — never reveal the block. Funnels the
      // customer to a human (Bill / Michael), who can decline at
      // the chair as they do today rather than be surprised by
      // a booking on the schedule.
      return fail(
        403,
        'BOOKING_NOT_ALLOWED',
        "We can't complete this booking online. Please call the shop at 740-297-4462 to schedule.",
      );
    }

    // Run the booking creation and marketing consent application in
    // parallel. applyMarketingConsent never throws (failures resolve to
    // { kind: 'failed' }), so this is safe; the booking is the critical
    // path and consent is best-effort metadata.
    const [booking, marketingDecision] = await Promise.all([
      createBooking({
        startAtUtc: payload.slot.startAtUtc,
        customerId: resolvedCustomerId,
        serviceVariationId: payload.service.variationId,
        serviceVariationVersion: payload.service.version,
        teamMemberId: payload.barber.id,
        durationMinutes: payload.service.durationMinutes,
        customerNote: payload.customer.note,
        idempotencyKey,
      }),
      marketingDecisionPromise.catch(
        (err): MarketingConsentDecision => ({
          kind: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        }),
      ),
    ]);
    if (marketingDecision.kind !== 'noop' || marketingDecision.reason !== 'no-signal') {
      logBooking({
        phase: 'marketing-consent',
        attemptId,
        customerId: resolvedCustomerId,
        marketingDecision: marketingDecision.kind,
      });
    }

    logBooking({
      phase: 'success',
      attemptId,
      customerEmail: redactEmail(payload.customer.email),
      customerInitials: initials,
      service: payload.service.name,
      startAtUtc: booking.start_at,
      bookingId: booking.id,
      customerId: resolvedCustomerId,
      durationMs: Date.now() - startedAt,
    });

    // Persist the {booking → card-on-file} mapping when this is a
    // new-customer booking with a captured card. KV failure must NOT
    // fail the booking — the appointment already exists in Square; the
    // worst outcome of a missing index entry is that we can't charge
    // for a no-show / late-cancel later. Log loudly so it's visible.
    //
    // The cardId presence — not the amount — is the trigger here. A
    // captured card with a zero/negative amount is a bug: someone got
    // through Step 4.5 without us knowing the price. Write the record
    // with the price we *do* have (clamped to zero, so a stray no-show
    // attempt produces an obvious $0 line in the audit log) and shout
    // about it so admin sees the warning.
    if (payload.cardOnFile?.cardId) {
      const amountCents =
        typeof payload.cardOnFile.amountCents === 'number' && payload.cardOnFile.amountCents > 0
          ? payload.cardOnFile.amountCents
          : 0;
      if (amountCents === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[BOOK] ${JSON.stringify({
            ts: new Date().toISOString(),
            phase: 'card-index-zero-amount',
            bookingId: booking.id,
            customerId: resolvedCustomerId,
            cardId: payload.cardOnFile.cardId,
            note: 'New-customer booking captured a card but amountCents was missing or non-positive — admin should reach out before relying on the no-show charge for this booking.',
          })}`,
        );
      }

      // Verify the card actually belongs to the resolved customer
      // BEFORE writing the KV record. Without this, a hostile or buggy
      // client could pass a cardId that belongs to a different customer
      // — the KV record would then later try to charge that card "on
      // behalf of" the wrong person. Square's createPayment would
      // reject it eventually, but we'd be left with a contaminated
      // index entry and confusing admin behavior. Better to refuse the
      // index write up-front and log loudly.
      let cardOwnershipVerified = false;
      try {
        const card = await getCard(payload.cardOnFile.cardId);
        cardOwnershipVerified = !!card && card.customer_id === resolvedCustomerId;
        if (!cardOwnershipVerified) {
          // eslint-disable-next-line no-console
          console.log(
            `[BOOK] ${JSON.stringify({
              ts: new Date().toISOString(),
              phase: 'card-ownership-mismatch',
              bookingId: booking.id,
              customerId: resolvedCustomerId,
              cardId: payload.cardOnFile.cardId,
              cardCustomerId: card?.customer_id ?? null,
              note: 'cardOnFile.cardId does not belong to the resolved customer — refusing to write KV index. Booking succeeded; no card on file for late-cancel/no-show.',
            })}`,
          );
        }
      } catch (cardErr) {
        const detail = cardErr instanceof Error ? cardErr.message : String(cardErr);
        // eslint-disable-next-line no-console
        console.log(
          `[BOOK] ${JSON.stringify({
            ts: new Date().toISOString(),
            phase: 'card-ownership-check-failed',
            bookingId: booking.id,
            customerId: resolvedCustomerId,
            cardId: payload.cardOnFile.cardId,
            detail,
          })}`,
        );
      }

      if (cardOwnershipVerified) {
        try {
          await createBookingCardRecord({
            bookingId: booking.id,
            squareCustomerId: resolvedCustomerId,
            squareCardId: payload.cardOnFile.cardId,
            servicePriceCents: amountCents,
            serviceName: payload.service.name,
            startAtUtc: booking.start_at,
          });
        } catch (kvErr) {
          const detail = kvErr instanceof Error ? kvErr.message : String(kvErr);
          // eslint-disable-next-line no-console
          console.log(
            `[BOOK] ${JSON.stringify({
              ts: new Date().toISOString(),
              phase: 'card-index-write-failed',
              bookingId: booking.id,
              customerId: resolvedCustomerId,
              cardId: payload.cardOnFile.cardId,
              detail,
            })}`,
          );
        }
      }
    }

    const success: CreateBookingSuccess = {
      ok: true,
      bookingId: booking.id,
      customerId: resolvedCustomerId,
      startAtUtc: booking.start_at,
    };
    return Response.json(success satisfies CreateBookingResponse, { status: 200 });
  } catch (err) {
    if (err instanceof SquareApiError) {
      const cls = classifySquareError(err);
      logBooking({
        phase: 'square-error',
        attemptId,
        customerEmail: redactEmail(payload.customer.email),
        service: payload.service.name,
        startAtUtc: payload.slot.startAtUtc,
        errorCode: cls.code,
        errorDetail: cls.detail,
        durationMs: Date.now() - startedAt,
      });
      return fail(cls.status, cls.code, cls.detail, {
        slotTaken: cls.slotTaken,
        leadTimeTooShort: cls.leadTimeTooShort,
      });
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    logBooking({
      phase: 'unexpected-error',
      attemptId,
      customerEmail: redactEmail(payload.customer.email),
      errorDetail: detail,
      durationMs: Date.now() - startedAt,
    });
    return fail(500, 'INTERNAL', 'Something went wrong on our side. Please try again.');
  }
};
