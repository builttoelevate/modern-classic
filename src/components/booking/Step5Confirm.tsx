import { useEffect, useState } from 'react';
import type { AvailabilitySlot, Barber, Service, ServiceVariation } from '../../lib/square/types';
import type { CustomerInfo, SeriesState, WizardStatus } from './wizardState';
import { digits, priceForService } from './wizardState';

interface Props {
  service: Service;
  variation: ServiceVariation;
  barber: Barber | null;
  anyBarber: boolean;
  /** When the assigned barber has set a customer-facing SMS phone on
   *  /barber/dashboard Settings, this is their E.164 number. Renders as
   *  a "Text {barberName}: {formatted}" sms link in the cancellation
   *  policy block. null = barber opted out (or "any barber") — block
   *  falls back to the self-service "manage in My Bookings" prompt. */
  barberPhoneE164?: string | null;
  slot: AvailabilitySlot;
  customer: CustomerInfo;
  status: WizardStatus;
  onConfirm: () => void;
  onEditSlot: () => void;
  onEditCustomer: () => void;
  onUpdateContactToggle: (value: boolean) => void;
  /** Fired from the success screen's "Book Ahead" button (replaces
   *  the previous "Book another" CTA). When provided, the button
   *  does a soft wizard reset (preserving the customer's contact
   *  info) instead of a hard navigation back to /book. Optional so
   *  the wizard can decide per-mount whether to surface it. */
  onBookAnother?: () => void;
  /** Book Ahead series state. When series.frequencyWeeks > 0 the
   *  summary renders the full visit list (pre-confirm) or the
   *  per-visit booking results (post-confirm) in place of the
   *  single-slot "When" row. */
  series: SeriesState;
  rescheduleMode?: boolean;
  /** When set, the customer captured a card on file in Step 4.5. We
   *  surface it on the summary so they know what's being held, and we
   *  swap the cancellation copy for the charge-aware version. */
  cardOnFile?: { brand: string | null; last4: string | null } | null;
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

function formatPhoneForDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : e164;
}

export function Step5Confirm({
  service,
  variation,
  barber,
  anyBarber,
  barberPhoneE164 = null,
  slot,
  customer,
  status,
  onConfirm,
  onUpdateContactToggle,
  rescheduleMode = false,
  cardOnFile = null,
  onBookAnother,
  series,
}: Props) {
  const isSeries = series.desiredCount > 1 && series.pickedSlots.length > 0;
  // First slot + every extra in the plan. Sorted chronologically
  // for display — pick order is an implementation detail.
  const seriesRows = isSeries
    ? [{ startAtUtc: slot.startAtUtc, isFirst: true as const }, ...series.pickedSlots.map((p) => ({
        startAtUtc: p.startAtUtc,
        isFirst: false as const,
      }))]
        .slice()
        .sort((a, b) => Date.parse(a.startAtUtc) - Date.parse(b.startAtUtc))
        .map((row) => {
          const result = series.bookingResults[row.startAtUtc];
          return {
            ...row,
            bookingId: result?.bookingId,
            bookingError: result?.error,
          };
        })
    : [];
  // Every picked slot is guaranteed available at pick time, so the
  // "bookable count" is just the total pick count. Kept as a named
  // variable for the Confirm-button label.
  const seriesBookableCount = isSeries ? seriesRows.length : 0;
  const [existingContact, setExistingContact] = useState<{ phone?: string; givenName?: string; familyName?: string } | null>(null);
  const [calendarSheetOpen, setCalendarSheetOpen] = useState(false);

  useEffect(() => {
    if (rescheduleMode) {
      setExistingContact(null);
      return;
    }
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
    const calParams = {
      startAtUtc: slot.startAtUtc,
      durationMinutes: variation.durationMinutes,
      title: `${service.name} — Modern Classic`,
      description: `Booking ref: ${status.bookingId}`,
      location: '819 Linden Avenue, Zanesville, OH 43701',
    };
    return (
      <div className="bw-step">
        <div className="bw-success">
          <div className="bw-success-icon" aria-hidden="true">✓</div>
          <h2>
            {rescheduleMode
              ? "You're rescheduled."
              : isSeries
                ? (() => {
                    const succeeded = seriesRows.filter((r) => !!r.bookingId && !r.bookingError).length;
                    return `You're booked for ${succeeded} ${succeeded === 1 ? 'visit' : 'visits'}.`;
                  })()
                : "You're booked."}
          </h2>
          <p>
            {rescheduleMode ? (
              <>
                Your appointment is now <strong>{formatLocal(slot.startAtUtc)}</strong>. We'll
                email a fresh confirmation shortly.
              </>
            ) : isSeries ? (
              <>
                Confirmation emails are on their way to <strong>{status.emailDestination}</strong>{' '}
                — one per visit. Your first chair is{' '}
                <strong>{formatLocal(slot.startAtUtc)}</strong>.
              </>
            ) : (
              <>
                We've sent a confirmation to <strong>{status.emailDestination}</strong>. See you on{' '}
                <strong>{formatLocal(slot.startAtUtc)}</strong>.
              </>
            )}
          </p>
          {isSeries && (
            <>
              <ol className="bw-success-visits">
                {seriesRows.map((row, idx) => {
                  const ok = !!row.bookingId && !row.bookingError;
                  // Sequential loop stops on first failure — anything
                  // after the failed visit was never attempted, so it
                  // has no bookingId and no bookingError. Surface that
                  // as "Not attempted" so the customer knows it wasn't
                  // a per-slot issue.
                  const wasSkipped = !ok && !row.bookingError;
                  const tag = ok
                    ? 'Confirmed'
                    : row.bookingError
                      ? row.bookingError
                      : wasSkipped
                        ? 'Not attempted'
                        : 'Not booked';
                  return (
                    <li
                      key={row.startAtUtc + idx}
                      className={`bw-success-visits__row bw-success-visits__row--${ok ? 'ok' : 'warn'}`}
                    >
                      <span className="bw-success-visits__num">{idx + 1}.</span>
                      <span className="bw-success-visits__when">{formatLocal(row.startAtUtc)}</span>
                      <span className="bw-success-visits__tag">{tag}</span>
                    </li>
                  );
                })}
              </ol>
              {(() => {
                const total = seriesRows.length;
                const succeeded = seriesRows.filter((r) => !!r.bookingId && !r.bookingError).length;
                if (succeeded === total) return null;
                const missing = total - succeeded;
                return (
                  <p className="bw-success-partial">
                    {succeeded} of {total} visits confirmed. {missing}{' '}
                    {missing === 1 ? "couldn't be booked" : "couldn't be booked"} —
                    visit My Bookings or email modernclassicbarbershop@protonmail.com to fill those in.
                  </p>
                );
              })()}
            </>
          )}
          <p>819 Linden Avenue, Zanesville, OH 43701</p>
          <div className="bw-success-id">Booking ref: {status.bookingId}</div>
          <div className="bw-success-actions">
            <button
              type="button"
              className="bw-btn bw-btn--ghost"
              onClick={() => setCalendarSheetOpen(true)}
            >
              Add to calendar
            </button>
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
              href="mailto:modernclassicbarbershop@protonmail.com"
            >
              Email the shop
            </a>
            <a className="bw-btn bw-btn--ghost" href="/my-bookings">
              View My Bookings
            </a>
            {!rescheduleMode &&
              (onBookAnother ? (
                <button
                  type="button"
                  className="bw-btn"
                  onClick={onBookAnother}
                >
                  Book ahead
                </button>
              ) : (
                <a className="bw-btn" href="/book">
                  Book ahead
                </a>
              ))}
            {rescheduleMode && (
              <a className="bw-btn" href="/my-bookings">
                Done
              </a>
            )}
          </div>
        </div>

        {calendarSheetOpen && (
          <CalendarSheet
            params={calParams}
            onClose={() => setCalendarSheetOpen(false)}
          />
        )}
      </div>
    );
  }

  const priceLabel = priceForService(service, variation);
  const isVariablePrice = variation.pricingType === 'VARIABLE_PRICING';

  const submitting = status.kind === 'submitting';

  return (
    <div className="bw-step">
      <div className="bw-step-head">
        <h2>{rescheduleMode ? 'Confirm your reschedule' : 'Confirm your booking'}</h2>
        <p>
          {rescheduleMode
            ? "Review the new time. We'll cancel the old slot once this one is locked in."
            : "Review the details. We'll send you a confirmation by email."}
        </p>
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
        {isSeries ? (
          <div className="bw-summary-row bw-summary-row--list">
            <span className="bw-summary-label">Visits ({seriesRows.length})</span>
            <ol className="bw-summary-visits">
              {seriesRows.map((row, idx) => (
                <li key={row.startAtUtc + idx} className="bw-summary-visits__row bw-summary-visits__row--ok">
                  <span className="bw-summary-visits__num">{idx + 1}.</span>
                  <span className="bw-summary-visits__when">{formatLocal(row.startAtUtc)}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="bw-summary-row">
            <span className="bw-summary-label">{rescheduleMode ? 'New time' : 'When'}</span>
            <span className="bw-summary-value">{formatLocal(slot.startAtUtc)}</span>
          </div>
        )}
        <div className="bw-summary-row">
          <span className="bw-summary-label">Duration</span>
          <span className="bw-summary-value">{variation.durationMinutes} min</span>
        </div>
        <div className="bw-summary-row">
          <span className="bw-summary-label">
            {isSeries ? `Price per visit` : 'Price'}
          </span>
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
        {!rescheduleMode && (
          <>
            {customer.bookingFor && customer.bookingFor.givenName.trim() && (
              <div className="bw-summary-row">
                <span className="bw-summary-label">For</span>
                <span className="bw-summary-value">
                  {customer.bookingFor.givenName.trim()}
                </span>
              </div>
            )}
            <div className="bw-summary-row">
              <span className="bw-summary-label">
                {customer.bookingFor && customer.bookingFor.givenName.trim()
                  ? 'Contact'
                  : 'Name'}
              </span>
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
          </>
        )}
        {rescheduleMode && customer.email && (
          <div className="bw-summary-row">
            <span className="bw-summary-label">Account</span>
            <span className="bw-summary-value">{customer.email}</span>
          </div>
        )}
        {customer.note && (
          <div className="bw-summary-row">
            <span className="bw-summary-label">Note</span>
            <span className="bw-summary-value">{customer.note}</span>
          </div>
        )}
      </div>

      {!rescheduleMode && existingContact && (
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

      {cardOnFile && (
        <div className="bw-summary-row">
          <span className="bw-summary-label">Card on file</span>
          <span className="bw-summary-value">
            {cardOnFile.brand ?? 'Card'} ending in {cardOnFile.last4 ?? '••••'}
          </span>
        </div>
      )}

      {cardOnFile ? (
        <div className="bw-policy bw-policy--charge">
          <strong>First-time visitor cancellation policy.</strong> Your card is held only.
          You will <strong>not</strong> be charged today. If you no-show or cancel within
          24 hours of your appointment, your card will be charged the full service price.
          To cancel or reschedule earlier, use{' '}
          <a className="link-gold" href="/my-bookings">My Bookings</a>
          {barberPhoneE164 && barber && (
            <>
              {' '}or text {barber.displayName}:{' '}
              <a className="link-gold" href={`sms:${barberPhoneE164}`}>
                {formatPhoneForDisplay(barberPhoneE164)}
              </a>
            </>
          )}.
          <div className="bw-policy__cta">
            <a className="link-gold" href="/cancellation-policy" target="_blank" rel="noopener">
              Read the full cancellation policy →
            </a>
          </div>
        </div>
      ) : (
        <div className="bw-policy">
          <strong>Cancellation policy.</strong> We ask for 24-hour notice for cancellations or
          reschedules. No-shows may be charged the full service price. To change this booking,
          use <a className="link-gold" href="/my-bookings">My Bookings</a>
          {barberPhoneE164 && barber && (
            <>
              {' '}or text {barber.displayName}:{' '}
              <a className="link-gold" href={`sms:${barberPhoneE164}`}>
                {formatPhoneForDisplay(barberPhoneE164)}
              </a>
            </>
          )}.
          <div className="bw-policy__cta">
            <a className="link-gold" href="/cancellation-policy" target="_blank" rel="noopener">
              Read the full cancellation policy →
            </a>
          </div>
        </div>
      )}

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
          {submitting
            ? (rescheduleMode ? 'Rescheduling…' : 'Booking…')
            : rescheduleMode
              ? 'Confirm new time'
              : isSeries
                ? `Confirm ${seriesBookableCount} bookings`
                : 'Confirm booking'}
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

// ---------- Calendar link helpers ----------

interface CalendarParams {
  startAtUtc: string;
  durationMinutes: number;
  title: string;
  description: string;
  location: string;
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function googleCalendarLink(p: CalendarParams): string {
  const start = new Date(p.startAtUtc);
  const end = new Date(start.getTime() + p.durationMinutes * 60_000);
  const u = new URL('https://www.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', p.title);
  u.searchParams.set('dates', `${utcStamp(start)}/${utcStamp(end)}`);
  u.searchParams.set('location', p.location);
  u.searchParams.set('details', p.description);
  return u.toString();
}

function outlookCalendarLink(p: CalendarParams): string {
  const start = new Date(p.startAtUtc);
  const end = new Date(start.getTime() + p.durationMinutes * 60_000);
  const u = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  u.searchParams.set('path', '/calendar/action/compose');
  u.searchParams.set('rru', 'addevent');
  u.searchParams.set('subject', p.title);
  u.searchParams.set('startdt', start.toISOString());
  u.searchParams.set('enddt', end.toISOString());
  u.searchParams.set('body', p.description);
  u.searchParams.set('location', p.location);
  return u.toString();
}

function yahooCalendarLink(p: CalendarParams): string {
  const start = new Date(p.startAtUtc);
  const end = new Date(start.getTime() + p.durationMinutes * 60_000);
  const u = new URL('https://calendar.yahoo.com/');
  u.searchParams.set('v', '60');
  u.searchParams.set('title', p.title);
  u.searchParams.set('st', utcStamp(start));
  u.searchParams.set('et', utcStamp(end));
  u.searchParams.set('desc', p.description);
  u.searchParams.set('in_loc', p.location);
  return u.toString();
}

// Apple / iOS Calendar: a data: URL containing a minimal ICS file. Tapping
// this on iOS Safari opens the native 'Add Event' sheet directly into
// Apple Calendar; on macOS Safari it opens Calendar.app the same way.
// We escape commas, semicolons, backslashes and newlines per RFC 5545.
function appleCalendarLink(p: CalendarParams): string {
  const start = new Date(p.startAtUtc);
  const end = new Date(start.getTime() + p.durationMinutes * 60_000);
  const esc = (s: string) =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  const host =
    typeof window !== 'undefined' && window.location?.host ? window.location.host : 'mdrnclassic.com';
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Modern Classic//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${utcStamp(start)}-${Math.random().toString(36).slice(2, 10)}@${host}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${esc(p.title)}`,
    `DESCRIPTION:${esc(p.description)}`,
    `LOCATION:${esc(p.location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}

// ---------- Calendar chooser sheet ----------

function CalendarSheet({ params, onClose }: { params: CalendarParams; onClose: () => void }) {
  // Close on Escape, lock body scroll while the sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const options = [
    {
      key: 'apple',
      label: 'Apple',
      href: appleCalendarLink(params),
      external: false,
      // .ics download triggers Apple Calendar on iOS / macOS.
      download: 'modern-classic-booking.ics',
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
          <path d="M16.4 12.7c0-2.4 2-3.5 2.1-3.5-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.6.9s-1.9-.9-3.1-.8c-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.1 1.8 2.4 3 2.4 1.2 0 1.7-.8 3.1-.8s1.8.8 3.1.8c1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.6-1-2.6-4zm-2.4-7.3c.7-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2-.5 2.7-1.3z"/>
        </svg>
      ),
    },
    {
      key: 'google',
      label: 'Google',
      href: googleCalendarLink(params),
      external: true,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
      ),
    },
    {
      key: 'outlook',
      label: 'Outlook',
      href: outlookCalendarLink(params),
      external: true,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect x="2" y="5" width="14" height="14" rx="1.5" fill="#0078D4"/>
          <path d="M9 8.5c-1.66 0-3 1.57-3 3.5s1.34 3.5 3 3.5 3-1.57 3-3.5-1.34-3.5-3-3.5zm0 5.5c-.83 0-1.5-.9-1.5-2s.67-2 1.5-2 1.5.9 1.5 2-.67 2-1.5 2z" fill="#fff"/>
          <path d="M16 9v6l5 1.5V7.5L16 9z" fill="#0078D4"/>
        </svg>
      ),
    },
    {
      key: 'yahoo',
      label: 'Yahoo',
      href: yahooCalendarLink(params),
      external: true,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M3 5h3.4l3.1 6 3.2-6h3.3l-5 9v6h-3v-6L3 5z" fill="#6001D2"/>
          <circle cx="18.5" cy="13" r="1.4" fill="#6001D2"/>
          <path d="M19 5h2.5l-1.6 6h-2.5L19 5z" fill="#6001D2"/>
        </svg>
      ),
    },
  ];

  return (
    <div className="bw-cal-sheet" role="dialog" aria-modal="true" aria-label="Add to calendar">
      <button
        type="button"
        className="bw-cal-sheet__scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="bw-cal-sheet__panel">
        <h3 className="bw-cal-sheet__title">Add to calendar</h3>
        <ul className="bw-cal-sheet__list">
          {options.map((o) => (
            <li key={o.key}>
              <a
                className="bw-cal-option"
                href={o.href}
                {...(o.external ? { target: '_blank', rel: 'noopener' } : {})}
                {...(o.download ? { download: o.download } : {})}
                onClick={() => {
                  // Small delay so iOS picks up the ICS download / external
                  // tab open before we unmount the sheet.
                  setTimeout(onClose, 250);
                }}
              >
                <span className="bw-cal-option__icon">{o.icon}</span>
                <span className="bw-cal-option__label">{o.label}</span>
              </a>
            </li>
          ))}
        </ul>
        <button type="button" className="bw-cal-sheet__close" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
