import { useEffect, useState } from 'react';
import type { AvailabilitySlot, Barber, Service, ServiceVariation } from '../../lib/square/types';
import type { CustomerInfo, WizardStatus } from './wizardState';
import { digits, priceForService } from './wizardState';

interface Props {
  service: Service;
  variation: ServiceVariation;
  barber: Barber | null;
  anyBarber: boolean;
  slot: AvailabilitySlot;
  customer: CustomerInfo;
  status: WizardStatus;
  onConfirm: () => void;
  onEditSlot: () => void;
  onEditCustomer: () => void;
  onBookAnother: () => void;
  onUpdateContactToggle: (value: boolean) => void;
}

interface CustomerLookupResponse {
  ok: boolean;
  exists?: boolean;
  givenName?: string;
  familyName?: string;
  phone?: string;
}

const SHOP_TZ = 'America/New_York';

function formatLocal(utc: string): string {
  const date = new Date(utc);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return dtf.format(date);
}

export function Step5Confirm({
  service,
  variation,
  barber,
  anyBarber,
  slot,
  customer,
  status,
  onConfirm,
  onBookAnother,
  onUpdateContactToggle,
}: Props) {
  const [existingContact, setExistingContact] = useState<{ phone?: string; givenName?: string; familyName?: string } | null>(null);

  useEffect(() => {
    const email = customer.email.trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      setExistingContact(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/square/customer-lookup?email=${encodeURIComponent(email)}`)
      .then((r) => r.json() as Promise<CustomerLookupResponse>)
      .then((d) => {
        if (cancelled) return;
        if (!d.ok || !d.exists) {
          setExistingContact(null);
          return;
        }
        const diff: { phone?: string; givenName?: string; familyName?: string } = {};
        const existingDigits = digits(d.phone ?? '').slice(-10);
        const enteredDigits = digits(customer.phone).slice(-10);
        if (existingDigits && enteredDigits && existingDigits !== enteredDigits) {
          diff.phone = d.phone;
        }
        if (
          d.givenName &&
          customer.givenName.trim() &&
          d.givenName.trim() !== customer.givenName.trim()
        ) {
          diff.givenName = d.givenName;
        }
        if (
          d.familyName &&
          customer.familyName.trim() &&
          d.familyName.trim() !== customer.familyName.trim()
        ) {
          diff.familyName = d.familyName;
        }
        setExistingContact(Object.keys(diff).length > 0 ? diff : null);
      })
      .catch(() => {
        if (!cancelled) setExistingContact(null);
      });
    return () => {
      cancelled = true;
    };
  }, [customer.email, customer.phone, customer.givenName, customer.familyName]);

  if (status.kind === 'success') {
    return (
      <div className="bw-step">
        <div className="bw-success">
          <div className="bw-success-icon" aria-hidden="true">✓</div>
          <h2>You're booked.</h2>
          <p>
            We've sent a confirmation to <strong>{status.emailDestination}</strong>. See you on{' '}
            <strong>{formatLocal(slot.startAtUtc)}</strong>.
          </p>
          <p>819 Linden Avenue, Zanesville, OH 43701</p>
          <div className="bw-success-id">Booking ref: {status.bookingId}</div>
          <div className="bw-success-actions">
            <a
              className="bw-btn bw-btn--ghost"
              href={googleCalendarLink({
                startAtUtc: slot.startAtUtc,
                durationMinutes: variation.durationMinutes,
                title: `${service.name} — Modern Classic`,
                description: `Booking ref: ${status.bookingId}`,
              })}
              target="_blank"
              rel="noopener"
            >
              Add to Google Calendar
            </a>
            <a
              className="bw-btn bw-btn--ghost"
              href="https://maps.google.com/?q=819+Linden+Avenue+Zanesville+OH+43701"
              target="_blank"
              rel="noopener"
            >
              Get directions
            </a>
            <a
              className="bw-btn bw-btn--ghost"
              href="tel:+17402974462"
            >
              Save shop number
            </a>
            <button
              type="button"
              className="bw-btn"
              onClick={onBookAnother}
            >
              Book another
            </button>
          </div>
        </div>
      </div>
    );
  }

  const priceLabel = priceForService(service, variation);
  const isVariablePrice = variation.pricingType === 'VARIABLE_PRICING';

  const submitting = status.kind === 'submitting';

  return (
    <div className="bw-step">
      <div className="bw-step-head">
        <h2>Confirm your booking</h2>
        <p>Review the details. We'll send you a confirmation by email.</p>
      </div>

      <div className="bw-summary">
        <div className="bw-summary-row">
          <span className="bw-summary-label">Service</span>
          <span className="bw-summary-value">{service.name}</span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">Barber</span>
          <span className="bw-summary-value">{anyBarber ? 'First available' : barber?.displayName ?? '—'}</span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">When</span>
          <span className="bw-summary-value">{formatLocal(slot.startAtUtc)}</span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">Duration</span>
          <span className="bw-summary-value">{variation.durationMinutes} min</span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">Price</span>
          <span className="bw-summary-value">
            {priceLabel}
            {isVariablePrice && (
              <>
                <br />
                <small style={{ color: 'var(--color-text-dim)', fontWeight: 400 }}>
                  Final price set at the appointment
                </small>
              </>
            )}
          </span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">Name</span>
          <span className="bw-summary-value">{customer.givenName} {customer.familyName}</span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">Email</span>
          <span className="bw-summary-value">{customer.email}</span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">Phone</span>
          <span className="bw-summary-value">{customer.phone}</span>
        </div>
        {customer.note && (
          <div className="bw-summary-row">
            <span className="bw-summary-label">Note</span>
            <span className="bw-summary-value">{customer.note}</span>
          </div>
        )}
      </div>

      {existingContact && (
        <div className="bw-note-update">
          <label>
            <input
              type="checkbox"
              checked={customer.updateContact}
              onChange={(e) => onUpdateContactToggle(e.target.checked)}
            />
            <span>
              We have a {describeDiff(existingContact)} on file from a previous booking under this email.{' '}
              <strong>Update it to what you entered above?</strong>
            </span>
          </label>
        </div>
      )}

      <div className="bw-policy">
        <strong>Cancellation policy.</strong> We ask for 24-hour notice for cancellations or
        reschedules. No-shows may be charged the full service price. To change this booking,
        call us at <a className="link-gold" href="tel:+17402974462">740-297-4462</a>.
      </div>

      {status.kind === 'error' && (
        <div className="bw-error" role="alert">
          {status.message}
        </div>
      )}

      <div className="bw-nav">
        <button
          type="button"
          className="bw-btn"
          disabled={submitting}
          onClick={onConfirm}
        >
          {submitting ? 'Booking…' : 'Confirm booking'}
        </button>
      </div>
    </div>
  );
}

function describeDiff(diff: { phone?: string; givenName?: string; familyName?: string }): string {
  const parts: string[] = [];
  if (diff.phone) parts.push('different phone number');
  if (diff.givenName || diff.familyName) parts.push('different name');
  if (parts.length === 0) return 'different contact info';
  if (parts.length === 1) return parts[0];
  return parts.join(' and a ');
}

function googleCalendarLink(params: {
  startAtUtc: string;
  durationMinutes: number;
  title: string;
  description: string;
}): string {
  const start = new Date(params.startAtUtc);
  const end = new Date(start.getTime() + params.durationMinutes * 60_000);
  const fmt = (d: Date): string =>
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const u = new URL('https://www.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', params.title);
  u.searchParams.set('dates', `${fmt(start)}/${fmt(end)}`);
  u.searchParams.set('location', '819 Linden Avenue, Zanesville, OH 43701');
  u.searchParams.set('details', params.description);
  return u.toString();
}
