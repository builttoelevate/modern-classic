import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  serviceName: string;
  barberName: string;
  /** Square IDs — passed through to the admin so 'Schedule' can deep-link. */
  serviceVariationId?: string | null;
  teamMemberId?: string | null;
  /** Pre-fill these if we already collected them in Step 4. */
  prefillName?: string;
  prefillEmail?: string;
  prefillPhone?: string;
}

interface WaitlistApiResponse {
  ok: boolean;
  error?: { code: string; detail: string };
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

export function WaitlistSheet({
  open,
  onClose,
  serviceName,
  barberName,
  serviceVariationId = null,
  teamMemberId = null,
  prefillName = '',
  prefillEmail = '',
  prefillPhone = '',
}: Props) {
  const [name, setName] = useState(prefillName);
  const [email, setEmail] = useState(prefillEmail);
  const [phone, setPhone] = useState(prefillPhone);
  const [preferredDate, setPreferredDate] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Sync prefill values back in if they change while the sheet was closed.
  useEffect(() => {
    if (open) {
      setName((current) => current || prefillName);
      setEmail((current) => current || prefillEmail);
      setPhone((current) => current || prefillPhone);
      setStatus('idle');
      setErrorMsg(null);
      // Focus first empty field when opening.
      requestAnimationFrame(() => firstFieldRef.current?.focus());
    }
  }, [open, prefillName, prefillEmail, prefillPhone]);

  // Esc-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while the sheet is open so the page behind doesn't
  // tug-of-war with the form on iOS Safari, which is what made the sheet
  // appear off-screen before — the page kept its scroll position and the
  // sheet (rendered via portal) lived above it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'submitting') return;
    setStatus('submitting');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          serviceName,
          barberName,
          serviceVariationId,
          teamMemberId,
          preferredDate: preferredDate.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json()) as WaitlistApiResponse;
      if (data.ok) {
        setStatus('success');
        return;
      }
      setStatus('error');
      setErrorMsg(data.error?.detail || 'Could not submit. Please try again.');
    } catch {
      setStatus('error');
      setErrorMsg('Network error. Please try again.');
    }
  };

  return createPortal(
    <div className="bw-waitlist" role="dialog" aria-modal="true" aria-labelledby="bw-waitlist-title">
      <button
        type="button"
        className="bw-waitlist__scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="bw-waitlist__panel">
        <header className="bw-waitlist__head">
          <h2 id="bw-waitlist-title">Join the waitlist</h2>
          <button
            type="button"
            className="bw-waitlist__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {status === 'success' ? (
          <div className="bw-waitlist__success">
            <p>
              <strong>You're on the list.</strong>
            </p>
            <p>
              We'll reach out as soon as a {serviceName} opening with {barberName} comes
              up — usually within a few days. Questions? Call{' '}
              <a className="link-gold" href="tel:+17402974462">740-297-4462</a>.
            </p>
            <div className="bw-waitlist__actions">
              <button type="button" className="bw-btn" onClick={onClose}>
                Got it
              </button>
            </div>
          </div>
        ) : (
          <form className="bw-waitlist__form" onSubmit={submit} noValidate>
            <p className="bw-waitlist__sub">
              Tell us how to reach you and we'll text or email when a{' '}
              <strong>{serviceName}</strong> opening with <strong>{barberName}</strong>{' '}
              comes up.
            </p>

            <label className="bw-field">
              <span className="bw-field__label">Name</span>
              <input
                ref={firstFieldRef}
                type="text"
                autoComplete="name"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <div className="bw-field-row">
              <label className="bw-field">
                <span className="bw-field__label">Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={120}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="bw-field">
                <span className="bw-field__label">Phone</span>
                <input
                  type="tel"
                  autoComplete="tel"
                  required
                  maxLength={32}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </label>
            </div>

            <label className="bw-field">
              <span className="bw-field__label">
                Preferred date <span className="bw-field__optional">(optional)</span>
              </span>
              <input
                type="text"
                placeholder="e.g. weekday afternoons, May 15+"
                maxLength={64}
                value={preferredDate}
                onChange={(e) => setPreferredDate(e.target.value)}
              />
            </label>

            <label className="bw-field">
              <span className="bw-field__label">
                Anything else? <span className="bw-field__optional">(optional)</span>
              </span>
              <textarea
                rows={3}
                maxLength={600}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            {errorMsg && (
              <p className="bw-waitlist__error" role="alert">
                {errorMsg}
              </p>
            )}

            <div className="bw-waitlist__actions">
              <button
                type="button"
                className="bw-btn bw-btn--ghost"
                onClick={onClose}
                disabled={status === 'submitting'}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="bw-btn"
                disabled={status === 'submitting'}
              >
                {status === 'submitting' ? 'Sending…' : 'Add me to the list'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
