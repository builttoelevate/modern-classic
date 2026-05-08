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

declare global {
  interface Window {
    // Square Web Payments SDK is attached to window.Square at runtime.
    // We type only the bits we use.
    Square?: {
      payments: (
        appId: string,
        locationId: string,
      ) => Promise<{
        card: (options?: unknown) => Promise<{
          attach: (selector: string) => Promise<void>;
          tokenize: () => Promise<{
            status: 'OK' | 'ERROR' | string;
            token?: string;
            errors?: Array<{ message?: string; field?: string }>;
            details?: { card?: { brand?: string; last4?: string } };
          }>;
          destroy: () => Promise<void> | void;
        }>;
      }>;
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
  const cardRef = useRef<{ tokenize: () => Promise<unknown>; destroy: () => unknown } | null>(null);
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
        'Card capture is not configured. Please call the shop at 740-297-4462 and we\'ll book you in by phone.',
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
        const card = await payments.card({
          style: {
            input: {
              color: '#f3ece0',
              fontSize: '16px',
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
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
    if (!cardRef.current) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = (await cardRef.current.tokenize()) as {
        status: string;
        token?: string;
        errors?: Array<{ message?: string }>;
        details?: { card?: { brand?: string; last4?: string } };
      };
      if (result.status !== 'OK' || !result.token) {
        const msg =
          result.errors && result.errors[0]?.message
            ? result.errors[0].message
            : 'Could not validate that card. Please check the details and try again.';
        setSubmitError(msg);
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
