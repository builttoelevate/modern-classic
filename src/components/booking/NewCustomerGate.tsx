interface Props {
  onAnswer: (claimedReturning: boolean) => void;
}

// Renders above the Step 1 service grid for anonymous visitors only.
// The answer drives whether Step 1 locks to the New Customer service
// (No → lock) or unlocks the full menu (Yes → unlock, verify at Step 5).
// Signed-in users never see this — their verdict comes from a server-
// side Square check, not a self-report.
export function NewCustomerGate({ onAnswer }: Props) {
  return (
    <div className="bw-newcust-gate" role="group" aria-labelledby="bw-newcust-gate-title">
      <p id="bw-newcust-gate-title" className="bw-newcust-gate__title">
        Welcome — have you visited Modern Classic before?
      </p>
      <div className="bw-newcust-gate__buttons">
        <button
          type="button"
          className="bw-btn bw-newcust-gate__btn"
          onClick={() => onAnswer(true)}
        >
          Yes, I'm a returning customer
        </button>
        <button
          type="button"
          className="bw-btn bw-btn--ghost bw-newcust-gate__btn"
          onClick={() => onAnswer(false)}
        >
          No, this is my first time
        </button>
      </div>
    </div>
  );
}
