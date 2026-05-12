import { useEffect, useRef, useState } from 'react';
import { customerInfoValid, digits, formatPhone } from './wizardState';
import type { CustomerInfo } from './wizardState';

interface Props {
  customer: CustomerInfo;
  onChange: (patch: Partial<CustomerInfo>) => void;
  onNext: () => void;
  /** When true, the "Who is this appointment for?" radio defaults
   *  to "Someone else" on first entry. Defers to the user's manual
   *  interaction on subsequent renders (service swaps mid-flow
   *  don't yank their choice). */
  defaultForSomeoneElse?: boolean;
}

export function Step4CustomerInfo({
  customer,
  onChange,
  onNext,
  defaultForSomeoneElse = false,
}: Props) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // userTouchedRadio gates the service-based default. Once the user
  // clicks either radio option, the defaultForSomeoneElse prop is
  // ignored for the rest of the session — so backtracking to Step 2,
  // picking a different service, and returning to Step 4 won't yank
  // their explicit choice. Initialized true when the form already
  // has bookingFor set (returning to Step 4 after submitting once
  // and coming back, or a server-rehydration path).
  const userTouchedRadio = useRef<boolean>(customer.bookingFor !== null);

  // Apply the service-based default exactly once per session — only
  // when the user hasn't touched the radio yet AND the wizard state
  // hasn't already been initialized with a bookingFor.
  useEffect(() => {
    if (userTouchedRadio.current) return;
    if (defaultForSomeoneElse && customer.bookingFor === null) {
      onChange({ bookingFor: { givenName: '' } });
    }
    // Intentionally not re-running when defaultForSomeoneElse flips
    // mid-flow (service swap) — the radio default is first-entry only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bookingForSomeoneElse = customer.bookingFor !== null;
  const valid = customerInfoValid(customer);

  const errors = {
    givenName: !customer.givenName.trim() ? 'First name is required' : '',
    familyName: !customer.familyName.trim() ? 'Last name is required' : '',
    email: !customer.email.trim()
      ? 'Email is required'
      : !/^\S+@\S+\.\S+$/.test(customer.email.trim())
        ? 'Enter a valid email'
        : '',
    phone:
      digits(customer.phone).length === 0
        ? 'Phone is required'
        : digits(customer.phone).length !== 10
          ? '10-digit US phone number'
          : '',
    note: customer.note.length > 500 ? 'Notes must be under 500 characters' : '',
    bookingForGivenName:
      bookingForSomeoneElse && !customer.bookingFor!.givenName.trim()
        ? "Their first name is required"
        : '',
  };

  const showError = (field: keyof typeof errors): string => {
    return touched[field] && errors[field] ? errors[field] : '';
  };

  function setRadio(forSomeoneElse: boolean) {
    userTouchedRadio.current = true;
    if (forSomeoneElse) {
      // Toggle ON: open the kid name field empty, ready for input.
      onChange({ bookingFor: { givenName: '' } });
    } else {
      // Toggle OFF: drop the field from form state entirely so it
      // can't leak into the submit payload.
      onChange({ bookingFor: null });
      // Also clear any touched state on the kid field so it
      // doesn't flash an error if the user toggles back.
      setTouched((t) => {
        if (!t.bookingForGivenName) return t;
        const next = { ...t };
        delete next.bookingForGivenName;
        return next;
      });
    }
  }

  const adultGivenLabel = bookingForSomeoneElse ? 'Your first name' : 'First name';
  const adultFamilyLabel = bookingForSomeoneElse ? 'Your last name' : 'Last name';

  return (
    <form
      className="bw-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onNext();
        } else {
          setTouched({
            givenName: true,
            familyName: true,
            email: true,
            phone: true,
            bookingForGivenName: true,
          });
        }
      }}
      noValidate
    >
      <div className="bw-step-head">
        <h2>Your details</h2>
        <p>So we can confirm and remind you about your appointment.</p>
      </div>

      <fieldset className="bw-booking-for">
        <legend>Who is this appointment for?</legend>
        <div className="bw-booking-for__choices">
          <label
            className={`bw-radio${!bookingForSomeoneElse ? ' bw-radio--selected' : ''}`}
          >
            <input
              type="radio"
              name="bw-booking-for"
              checked={!bookingForSomeoneElse}
              onChange={() => setRadio(false)}
            />
            <span>Me</span>
          </label>
          <label
            className={`bw-radio${bookingForSomeoneElse ? ' bw-radio--selected' : ''}`}
          >
            <input
              type="radio"
              name="bw-booking-for"
              checked={bookingForSomeoneElse}
              onChange={() => setRadio(true)}
            />
            <span>Someone else</span>
          </label>
        </div>
        {bookingForSomeoneElse && (
          <p className="bw-booking-for__helper">
            {defaultForSomeoneElse
              ? "Kids haircuts are usually booked by a parent or guardian. We'll keep your contact info on file and book the appointment under your child's name."
              : "We'll use your contact info for confirmations and reminders."}
          </p>
        )}
      </fieldset>

      <div className="bw-form">
        {bookingForSomeoneElse && (
          <h3 className="bw-section-head">Your info</h3>
        )}

        <div className="bw-form-row bw-form-row--two">
          <div className="bw-field">
            <label htmlFor="bw-given">{adultGivenLabel}</label>
            <input
              id="bw-given"
              type="text"
              autoComplete="given-name"
              value={customer.givenName}
              onChange={(e) => onChange({ givenName: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, givenName: true }))}
              required
            />
            {showError('givenName') && <span className="bw-field-error">{showError('givenName')}</span>}
          </div>
          <div className="bw-field">
            <label htmlFor="bw-family">{adultFamilyLabel}</label>
            <input
              id="bw-family"
              type="text"
              autoComplete="family-name"
              value={customer.familyName}
              onChange={(e) => onChange({ familyName: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, familyName: true }))}
              required
            />
            {showError('familyName') && <span className="bw-field-error">{showError('familyName')}</span>}
          </div>
        </div>

        <div className="bw-form-row bw-form-row--two">
          <div className="bw-field">
            <label htmlFor="bw-email">Email</label>
            <input
              id="bw-email"
              type="email"
              autoComplete="email"
              value={customer.email}
              onChange={(e) => onChange({ email: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              required
            />
            {showError('email') && <span className="bw-field-error">{showError('email')}</span>}
          </div>
          <div className="bw-field">
            <label htmlFor="bw-phone">Mobile phone</label>
            <input
              id="bw-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="(555) 555-5555"
              value={customer.phone}
              onChange={(e) => onChange({ phone: formatPhone(e.target.value) })}
              onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
              required
            />
            {showError('phone') && <span className="bw-field-error">{showError('phone')}</span>}
          </div>
        </div>

        {bookingForSomeoneElse && (
          <>
            <h3 className="bw-section-head">Who's the appointment for?</h3>
            <div className="bw-field">
              <label htmlFor="bw-booking-for-given">Their first name</label>
              <input
                id="bw-booking-for-given"
                type="text"
                autoComplete="off"
                value={customer.bookingFor?.givenName ?? ''}
                onChange={(e) =>
                  onChange({ bookingFor: { givenName: e.target.value } })
                }
                onBlur={() => setTouched((t) => ({ ...t, bookingForGivenName: true }))}
                required
              />
              {showError('bookingForGivenName') && (
                <span className="bw-field-error">{showError('bookingForGivenName')}</span>
              )}
            </div>
          </>
        )}

        <div className="bw-field">
          <label htmlFor="bw-note">Note for your barber (optional)</label>
          <textarea
            id="bw-note"
            value={customer.note}
            maxLength={500}
            onChange={(e) => onChange({ note: e.target.value })}
            placeholder="Anything we should know? Specific style, length, etc."
          />
          <span className="bw-field-counter">{customer.note.length}/500</span>
        </div>

        <label className="bw-consent">
          <input
            type="checkbox"
            checked={customer.marketingConsent}
            onChange={(e) => onChange({ marketingConsent: e.target.checked })}
          />
          <span>
            Send me occasional offers, product recommendations, and shop updates from
            Modern Classic Barbershop. I can unsubscribe anytime.
          </span>
        </label>

        <button type="submit" className="bw-btn" disabled={!valid}>
          Review booking →
        </button>
      </div>
    </form>
  );
}
