import { useState } from 'react';
import { WaitlistSheet } from '../booking/WaitlistSheet';

interface Props {
  /** The barber currently displayed on the HeroAvailability pill, if any.
   * Lets the waitlist entry inherit context — "I want this barber sooner
   * than the slot above." When absent (fallback mode, no slot found) we
   * default to the flexible "Any barber" sentinel and the WaitlistSheet
   * copy adjusts accordingly. */
  barberName?: string;
  /** Square team_member_id matching barberName above, when known. */
  teamMemberId?: string | null;
  /** Active barber roster — when provided, the WaitlistSheet shows a
   * dropdown defaulting to "Any barber" so the customer can pick. */
  barberOptions?: Array<{ id: string; displayName: string }>;
}

/**
 * Tertiary CTA that hangs off the HeroAvailability pill: "Need it sooner?
 * Join the waitlist." Visually subordinate to the existing primary
 * (Book An Appointment) and secondary (Shop Our Products) hero buttons.
 *
 * Rendered as an Astro client island so the hero stays mostly static.
 * The waitlist machinery (sheet UI, /api/waitlist, Resend, cron, admin
 * inbox) is unchanged from Phase 8 — this just adds a hero-level
 * entry point.
 */
export function HeroWaitlistTrigger({
  barberName,
  teamMemberId = null,
  barberOptions,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="hero-waitlist-trigger"
        onClick={() => setOpen(true)}
      >
        <span className="hero-waitlist-trigger__lead">Need it sooner?</span>
        <span className="hero-waitlist-trigger__cta">
          Join the waitlist
          <span className="hero-waitlist-trigger__arrow" aria-hidden="true">→</span>
        </span>
      </button>

      <WaitlistSheet
        open={open}
        onClose={() => setOpen(false)}
        serviceName="Any service"
        barberName={barberName ?? 'Any barber'}
        teamMemberId={teamMemberId}
        serviceVariationId={null}
        barberOptions={barberOptions}
      />
    </>
  );
}
