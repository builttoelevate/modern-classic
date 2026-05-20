// Step 4.5 — card-on-file capture for new customers only.
//
// Loads the Square Web Payments SDK from web.squarecdn.com (or its
// sandbox URL when PUBLIC_SQUARE_ENVIRONMENT=sandbox), renders the
// Square card form, tokenizes the card client-side, then POSTs the
// nonce to /api/booking/save-card to persist as a card-on-file under
// the Square customer record resolved earlier by
// /api/booking/check-new-customer.
//
// The Submit button stays disabled until:
//   1. the SDK has finished loading + attached the card form,
//   2. the customer ticks the policy-acknowledgement checkbox,
//   3. (after click) tokenize+save succeeds.

import { useEffect, useRef, useState } from 'react';

interface Props {
  customerId: string;
  cardholderName: string;
  /** First name from the booking form. Passed to Square's verifyBuyer
   *  as billingContact.givenName — required for the SCA verification
   *  Square does before allowing a card to be stored on file. */
  customerGivenName: string;
  /** Last name — paired with customerGivenName for billingContact. */
  customerFamilyName: string;
  /** Charge amount preview displayed next to the policy callout, e.g. "$45". */
  servicePriceDisplay: string;
  acknowledgedPolicy: boolean;
  onAcknowledgeChange: (value: boolean) => void;
  onSaved: (input: {
    cardId: string;
    cardLast4: string | undefined;
    cardBrand: string | undefined;
  }) => void;
  /** Existing card-on-file from a previous attempt — when present we
   *  show the captured-state UI and let the user continue immediately. */
  existingCard: { last4: string | null; brand: string | null } | null;
}

const SDK_PROD_URL = 'https://web.squarecdn.com/v1/square.js';
const SDK_SANDBOX_URL = 'https://sandbox.web.squarecdn.com/v1/square.js';

interface SquareCardInstance {
  attach: (selector: string) => Promise<void>;
  tokenize: () => Promise<{
    status: 'OK' | 'ERROR' | string;
    token?: string;
    errors?: Array<{ message?: string; field?: string }>;
    details?: { card?: { brand?: string; last4?: string } };
  }>;
  destroy: () => Promise<void> | void;
}

interface SquarePaymentsInstance {
  card: (options?: unknown) => Promise<SquareCardInstance>;
  // Square's SCA / 3DS step. Required for storing a card on file —
  // CreateCard rejects with "Invalid card data." when source_id came from
  // a nonce that wasn't paired with a verifyBuyer token.
  verifyBuyer: (
    sourceId: string,
    verificationDetails: {
      amount: string;
      currencyCode: string;
      intent: 'CHARGE' | 'STORE' | 'CHARGE_AND_STORE';
      billingContact?: {
        givenName?: string;
        familyName?: string;
        countryCode?: string;
        email?: string;
        phone?: string;
      };
      customerInitiated: boolean;
      sellerKeyedIn: boolean;
    },
  ) => Promise<{ token: string; details?: { cardBrand?: string } }>;
}

declare global {
  interface Window {
    // Square Web Payments SDK is attached to window.Square at runtime.
    // We type only the bits we use.
    Square?: {
      payments: (appId: string, locationId: string) => Promise<SquarePaymentsInstance>;
    };
  }
}

function getEnv(): { appId: string | null; locationId: string | null; sandbox: boolean } {
  const appId =
    (typeof import.meta.env !== 'undefined' &&
      (import.meta.env.PUBLIC_SQUARE_APPLICATION_ID as string | undefined)) ||
    null;
  const locationId =
    (typeof import.meta.env !== 'undefined' &&
      (import.meta.env.PUBLIC_SQUARE_LOCATION_ID as string | undefined)) ||
    null;
  const env =
    (typeof import.meta.env !== 'undefined' &&
      (import.meta.env.PUBLIC_SQUARE_ENVIRONMENT as string | undefined)) ||
    'production';
  return {
    appId: appId && appId.trim() ? appId.trim() : null,
    locationId: locationId && locationId.trim() ? locationId.trim() : null,
    sandbox: env.toLowerCase() === 'sandbox',
  };
}

async function loadSdk(sandbox: boolean): Promise<void> {
  if (typeof window === 'undefined') return;
  if (window.Square) return;
  const url = sandbox ? SDK_SANDBOX_URL : SDK_PROD_URL;
  // Reuse an existing script tag if one is already in flight.
  const existing = document.querySelector<HTMLScriptElement>(`script[data-mc-square-sdk]`);
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Square SDK load failed')), {
        once: true,
      });
      // If already loaded by the time we attach, the load event may
      // have fired — fall through after a microtask if window.Square is set.
      queueMicrotask(() => {
        if (window.Square) resolve();
      });
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.dataset.mcSquareSdk = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Square SDK failed to load'));
    document.head.appendChild(script);
  });
}

export function Step45CardCapture({
  customerId,
  cardholderName,
  customerGivenName,
  customerFamilyName,
  servicePriceDisplay,
  acknowledgedPolicy,
  onAcknowledgeChange,
  onSaved,
  existingCard,
}: Props) {
  const [sdkState, setSdkState] = useState<'loading' | 'ready' | 'error'>(
    existingCard ? 'ready' : 'loading',
  );
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cardRef = useRef<SquareCardInstance | null>(null);
  // Held across renders so submit() can call verifyBuyer() with the same
  // payments instance that produced the card form. Re-initializing the
  // instance mid-submit would lose the SCA challenge context.
  const paymentsRef = useRef<SquarePaymentsInstance | null>(null);
  const cardContainerId = 'mc-square-card-container';

  // SDK + card-form lifecycle. Once a card has been saved we leave the
  // form alone (existingCard !== null) so a re-render doesn't tear down
  // a successfully-captured card.
  useEffect(() => {
    if (existingCard) return;
    let cancelled = false;
    const env = getEnv();
    if (!env.appId || !env.locationId) {
      setSdkState('error');
      setSdkError(
        "Card capture is not configured. Please email modernclassicbarbershop@protonmail.com and we'll help you book.",
      );
      return;
    }
    setSdkState('loading');
    setSdkError(null);

    (async () => {
      try {
        await loadSdk(env.sandbox);
        if (cancelled) return;
        if (!window.Square) throw new Error('Square SDK did not initialize');
        const payments = await window.Square.payments(env.appId!, env.locationId!);
        if (cancelled) return;
        paymentsRef.current = payments;
        const card = await payments.card({
          style: {
            input: {
              color: '#f3ece0',
              fontSize: '16px',
              fontFamily: 'sans-serif',
              backgroundColor: '#1d1916',
            },
            '.input-container': {
              borderColor: '#2a2520',
              borderRadius: '6px',
            },
            '.input-container.is-focus': {
              borderColor: '#c9a35c',
            },
            '.input-container.is-error': {
              borderColor: '#ef6e54',
            },
            '.message-text': {
              color: '#f0a37a',
            },
            '.message-icon': {
              color: '#f0a37a',
            },
          },
        });
        if (cancelled) {
          card.destroy?.();
          return;
        }
        await card.attach(`#${cardContainerId}`);
        if (cancelled) {
          card.destroy?.();
          return;
        }
        cardRef.current = card;
        setSdkState('ready');
      } catch (err) {
        if (cancelled) return;
        setSdkState('error');
        setSdkError(
          err instanceof Error
            ? `Card form failed to load: ${err.message}`
            : 'Card form failed to load.',
        );
      }
    })();

    return () => {
      cancelled = true;
      try {
        cardRef.current?.destroy?.();
      } catch {
        // SDK can throw on double-destroy; safe to ignore.
      }
      cardRef.current = null;
    };
  }, [customerId, existingCard]);

  const submit = async () => {
    if (!cardRef.current || !paymentsRef.current) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await cardRef.current.tokenize();
      if (result.status !== 'OK' || !result.token) {
        const msg =
          result.errors && result.errors[0]?.message
            ? result.errors[0].message
            : 'Could not validate that card. Please check the details and try again.';
        setSubmitError(msg);
        setSubmitting(false);
        return;
      }

      // Square requires an SCA verification token paired with the nonce
      // before it'll let us store the card on file. STORE intent +
      // amount '0.00' is the standard "vault for later" pattern — the
      // policy callout above already disclosed the worst-case charge.
      let verificationToken: string | undefined;
      try {
        const verify = await paymentsRef.current.verifyBuyer(result.token, {
          amount: '0.00',
          currencyCode: 'USD',
          intent: 'STORE',
          billingContact: {
            givenName: customerGivenName || undefined,
            familyName: customerFamilyName || undefined,
            countryCode: 'US',
          },
          customerInitiated: true,
          sellerKeyedIn: false,
        });
        verificationToken = verify.token;
      } catch (verifyErr) {
        setSubmitError(
          verifyErr instanceof Error
            ? `Could not verify card with your bank: ${verifyErr.message}`
            : 'Could not verify card with your bank. Please try again.',
        );
        setSubmitting(false);
        return;
      }

      const res = await fetch('/api/booking/save-card', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          sourceId: result.token,
          verificationToken,
          cardholderName: cardholderName || undefined,
        }),
      });
      const body = (await res.json()) as
        | { ok: true; cardId: string; last4?: string; brand?: string }
        | { ok: false; error: { code: string; detail: string } };
      if (!res.ok || !body.ok) {
        const detail = !body.ok ? body.error.detail : 'We could not save the card.';
        setSubmitError(detail);
        setSubmitting(false);
        return;
      }
      onSaved({
        cardId: body.cardId,
        cardLast4: body.last4 ?? result.details?.card?.last4,
        cardBrand: body.brand ?? result.details?.card?.brand,
      });
      setSubmitting(false);
    } catch (err) {
      setSubmitting(false);
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Could not save the card. Please try again.',
      );
    }
  };

  return (
    <div className="bw-step bw-cardstep">
      <div className="bw-step-head">
        <h2>Save a card to hold your spot</h2>
        <p>
          We need a card on file for first-time clients. You will not be charged today.
        </p>
      </div>

      <div className="bw-cardstep-policy" role="note">
        <strong>First-time visitor policy</strong>
        <p>
          We require a card on file for new clients to protect against no-shows.
          <strong> You will NOT be charged today.</strong> Your card is only charged
          the full service price ({servicePriceDisplay}) if you no-show or cancel
          within 24 hours of your appointment.
        </p>
        <p className="bw-cardstep-policy__link">
          <a className="link-gold" href="/cancellation-policy" target="_blank" rel="noopener">
            Read the full cancellation policy →
          </a>
        </p>
      </div>

      {existingCard ? (
        <div className="bw-cardstep-saved" role="status">
          <span className="bw-cardstep-saved__check" aria-hidden="true">✓</span>
          <span>
            Card on file: <strong>{existingCard.brand ?? 'Card'} ending in {existingCard.last4 ?? '••••'}</strong>
          </span>
        </div>
      ) : (
        <>
          {sdkState === 'error' && sdkError && (
            <div className="bw-error" role="alert">{sdkError}</div>
          )}
          <div className="bw-cardstep-form">
            <div id={cardContainerId} className="bw-cardstep-form__field" />
            {sdkState === 'loading' && (
              <p className="bw-cardstep-form__hint">Loading secure card form…</p>
            )}
            {sdkState !== 'error' && (
              <p className="bw-cardstep-form__secure">
                <svg
                  className="bw-cardstep-form__secure-icon"
                  width="16"
                  height="18"
                  viewBox="0 0 12 14"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3 6V4a3 3 0 1 1 6 0v2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                  <rect
                    x="1.5"
                    y="6"
                    width="9"
                    height="7"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                </svg>
                <span>
                  <strong>Secured by Square.</strong> Your card details are
                  encrypted and never touch our servers.
                </span>
              </p>
            )}
          </div>
        </>
      )}

      <label className="bw-cardstep-ack">
        <input
          type="checkbox"
          checked={acknowledgedPolicy}
          onChange={(e) => onAcknowledgeChange(e.target.checked)}
        />
        <span>
          I understand my card will be charged the full service price if I no-show
          or cancel within 24 hours.
        </span>
      </label>

      {submitError && !existingCard && (
        <div className="bw-error" role="alert">{submitError}</div>
      )}

      {!existingCard && (
        <div className="bw-nav">
          <button
            type="button"
            className="bw-btn"
            disabled={sdkState !== 'ready' || !acknowledgedPolicy || submitting}
            onClick={submit}
          >
            {submitting ? 'Saving card…' : 'Save card and continue'}
          </button>
        </div>
      )}
    </div>
  );
}
