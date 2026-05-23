interface Props {
  onSwitch: () => void;
}

// Triggered from the BookingWizard's Step 5 check-new-customer effect
// when an anonymous visitor claimed they're a returning customer at
// the Step 1 gate, but the Square lookup against their entered email/
// phone turned up no booking history AND their picked service isn't
// the first-visit one. Forces them to either (a) switch to the New
// Customer service or (b) sign in under the email tied to their real
// account. There's no dismiss path on purpose — we want the routing
// decision to happen before they commit a booking.
export function NewCustomerMismatchModal({ onSwitch }: Props) {
  return (
    <div className="bw-mismatch-overlay" role="presentation">
      <div
        className="bw-mismatch-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="bw-mismatch-title"
        aria-describedby="bw-mismatch-body"
      >
        <h2 id="bw-mismatch-title" className="bw-mismatch-modal__title">
          Welcome — looks like this is your first visit
        </h2>
        <p id="bw-mismatch-body" className="bw-mismatch-modal__body">
          We couldn't find a previous booking under the email or phone you entered.
          First-time customers start with the New Customer service so Michael can
          set pricing and tailor the cut in person.
        </p>
        <div className="bw-mismatch-modal__actions">
          <button type="button" className="bw-btn" onClick={onSwitch}>
            Switch to New Customer service
          </button>
          <a className="bw-btn bw-btn--ghost" href="/sign-in?redirect=/book">
            Sign in instead
          </a>
        </div>
      </div>
    </div>
  );
}
