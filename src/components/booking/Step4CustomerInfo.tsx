import { useState } from 'react';
import { customerInfoValid, digits, formatPhone } from './wizardState';
import type { CustomerInfo } from './wizardState';

interface Props {
  customer: CustomerInfo;
  onChange: (patch: Partial<CustomerInfo>) => void;
  onNext: () => void;
}

export function Step4CustomerInfo({ customer, onChange, onNext }: Props) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
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
  };

  const showError = (field: keyof typeof errors): string => {
    return touched[field] && errors[field] ? errors[field] : '';
  };

  return (
    <form
      className="bw-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onNext();
        else setTouched({ givenName: true, familyName: true, email: true, phone: true });
      }}
      noValidate
    >
      <div className="bw-step-head">
        <h2>Your details</h2>
        <p>So we can confirm and remind you about your appointment.</p>
      </div>

      <div className="bw-form">
        <div className="bw-form-row bw-form-row--two">
          <div className="bw-field">
            <label htmlFor="bw-given">First name</label>
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
            <label htmlFor="bw-family">Last name</label>
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
