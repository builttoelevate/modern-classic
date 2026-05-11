// Phase 8 — auto-notify waitlist cron.
//
// Runs hourly via .github/workflows/hourly-waitlist-notifications.yml
// (Vercel Hobby caps cron at daily, so GitHub Actions drives the schedule
// and hits this endpoint with WAITLIST_NOTIFY_SECRET). For each active
// waitlist entry, fetches Square availability for that entry's
// (service, barber) combo across the customer's date window, runs the
// pure findMatchingSlot() filter, and emails them via Resend the moment
// a slot appears that matches their preferences.
//
// Anti-spam: matcher enforces a 12-hour per-entry cooldown plus
// per-slot dedup (notifiedSlotStartAtUtc). Anti-flap: an entry whose
// dateTo has passed gets auto-archived.
//
// Mirrors the auth + dryRun + log shape of review-requests.ts so an
// operator only has to learn the pattern once.

import type { APIRoute } from 'astro';
import {
  getEntryBarberPicks,
  listActiveWaitlistEntries,
  markWaitlistNotified,
  updateWaitlistStatus,
  type WaitlistEntry,
} from '../../../lib/marketing/waitlistLog';
import { findMatchingSlot, isWindowExpired } from '../../../lib/marketing/waitlistMatch';
import {
  searchAvailabilityChunked,
  searchWindowFor,
} from '../../../lib/marketing/waitlistSlotSuggestions';
import {
  sendWaitlistOpening,
  sendWaitlistSlotMatchBarber,
} from '../../../lib/email/resend';
import { resolveBarberContact } from '../../../lib/barber/contactLookup';
import { formatRelativeSlot } from '../../../lib/availability/timing';
import { redactEmail } from '../../../lib/booking/log';
import { SquareApiError } from '../../../lib/square/client';
import type { AvailabilitySlot } from '../../../lib/square/types';

export const prerender = false;

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';

interface CronOk {
  ok: true;
  ranAt: string;
  dryRun: boolean;
  scanned: number;
  archived: number;
  matched: number;
  sent: number;
  skipped: {
    noVariation: number;
    noSlotsInWindow: number;
    cooldown: number;
    emptyEmail: number;
  };
  failures: number;
  failureDetails: Array<{ entryId: string; reason: string }>;
}

interface CronFail {
  ok: false;
  error: { code: string; detail: string };
}

function logCron(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[WAITLIST-CRON] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isAuthorized(request: Request): boolean {
  const expected = import.meta.env.WAITLIST_NOTIFY_SECRET;
  if (typeof expected !== 'string' || !expected) return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const supplied = header.slice(7).trim();
  return constantTimeEqual(supplied, expected);
}

async function handle(request: Request): Promise<Response> {
  if (!import.meta.env.WAITLIST_NOTIFY_SECRET) {
    const body: CronFail = {
      ok: false,
      error: { code: 'CRON_NOT_CONFIGURED', detail: 'WAITLIST_NOTIFY_SECRET is not set.' },
    };
    return Response.json(body, { status: 503 });
  }
  if (!isAuthorized(request)) {
    logCron({ phase: 'unauthorized', method: request.method });
    const body: CronFail = {
      ok: false,
      error: { code: 'UNAUTHORIZED', detail: 'Missing or invalid WAITLIST_NOTIFY_SECRET.' },
    };
    return Response.json(body, { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const now = new Date();
  const origin = url.origin;

  const stats: CronOk = {
    ok: true,
    ranAt: now.toISOString(),
    dryRun,
    scanned: 0,
    archived: 0,
    matched: 0,
    sent: 0,
    skipped: { noVariation: 0, noSlotsInWindow: 0, cooldown: 0, emptyEmail: 0 },
    failures: 0,
    failureDetails: [],
  };

  let entries: WaitlistEntry[];
  try {
    entries = await listActiveWaitlistEntries({ limit: 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logCron({ phase: 'list-failed', errorDetail: detail });
    return Response.json(
      { ok: false, error: { code: 'LIST_FAILED', detail } } satisfies CronFail,
      { status: 502 },
    );
  }

  logCron({ phase: 'scan-start', count: entries.length, dryRun });

  for (const entry of entries) {
    stats.scanned++;
    try {
      // Auto-archive entries whose date window has ended.
      if (isWindowExpired(entry, now)) {
        if (!dryRun) {
          await updateWaitlistStatus({
            id: entry.id,
            status: 'archived',
            adminNote: 'Auto-archived: preferred date window passed.',
          });
        }
        stats.archived++;
        logCron({
          phase: 'archived',
          entryId: entry.id,
          email: redactEmail(entry.customerEmail),
          dateTo: entry.dateTo,
        });
        continue;
      }

      // Skip cooldown'd entries up front — same logic the matcher
      // enforces, but we report it cleanly in stats.
      if (entry.lastNotifiedAt) {
        const lastMs = new Date(entry.lastNotifiedAt).getTime();
        if (Number.isFinite(lastMs) && now.getTime() - lastMs < 12 * 60 * 60 * 1000) {
          stats.skipped.cooldown++;
          continue;
        }
      }

      if (!entry.serviceVariationId) {
        // Legacy entry submitted before we captured Square IDs in the
        // form. Can't search availability without one. The shop sees
        // these in /admin/waitlist and can manually action them.
        stats.skipped.noVariation++;
        continue;
      }
      if (!entry.customerEmail || !entry.customerEmail.trim()) {
        stats.skipped.emptyEmail++;
        continue;
      }

      const window = searchWindowFor(entry, now);
      if (!window) {
        stats.skipped.noSlotsInWindow++;
        continue;
      }

      // Multi-pick: customer may have asked to be notified about any of
      // several barbers. Search each one's availability, run the matcher,
      // and pick the earliest match across the whole set. An empty list
      // (legacy entry with no IDs at all OR explicit "any barber") falls
      // through to a single search with no team filter.
      const picks = getEntryBarberPicks(entry);
      const queries: Array<{ teamMemberId?: string; displayName: string | null }> =
        picks.length > 0
          ? picks.map((p) => ({ teamMemberId: p.id, displayName: p.displayName }))
          : [{ teamMemberId: undefined, displayName: null }];

      let bestMatch: { slot: AvailabilitySlot; teamMemberId?: string; displayName: string | null } | null = null;
      for (const q of queries) {
        const slots = await searchAvailabilityChunked({
          serviceVariationId: entry.serviceVariationId,
          teamMemberId: q.teamMemberId,
          startAt: window.startAt,
          endAt: window.endAt,
          // Cron only needs the earliest match; bail out of further
          // chunks as soon as Square hands us any candidate.
          stopAfter: 1,
        });
        const m = findMatchingSlot(entry, slots, now);
        if (!m) continue;
        if (!bestMatch || m.startAtUtc < bestMatch.slot.startAtUtc) {
          bestMatch = { slot: m, teamMemberId: q.teamMemberId, displayName: q.displayName };
        }
      }

      if (!bestMatch) {
        stats.skipped.noSlotsInWindow++;
        continue;
      }

      stats.matched++;
      const match = bestMatch.slot;
      const matchedBarberName =
        bestMatch.displayName ?? entry.barberName;
      const whenLabel = formatRelativeSlot(match.startAtUtc);
      const bookParams = new URLSearchParams();
      if (entry.serviceVariationId) bookParams.set('service', entry.serviceVariationId);
      if (bestMatch.teamMemberId) bookParams.set('barber', bestMatch.teamMemberId);
      const bookUrl = `${origin}/book${bookParams.toString() ? `?${bookParams.toString()}` : ''}`;

      if (dryRun) {
        logCron({
          phase: 'dry-run-would-send',
          entryId: entry.id,
          email: redactEmail(entry.customerEmail),
          slot: match.startAtUtc,
          whenLabel,
          matchedBarber: matchedBarberName,
        });
        stats.sent++;
        continue;
      }

      const sendResult = await sendWaitlistOpening({
        to: entry.customerEmail,
        customerName: entry.customerName,
        barberName: matchedBarberName,
        serviceName: entry.serviceName,
        whenLabel,
        bookUrl,
        shopAddress: SHOP_ADDRESS,
        shopPhone: SHOP_PHONE,
      });

      await markWaitlistNotified(entry.id, match.startAtUtc);
      stats.sent++;
      logCron({
        phase: 'sent',
        entryId: entry.id,
        email: redactEmail(entry.customerEmail),
        slot: match.startAtUtc,
        resendId: sendResult.id,
      });

      // Barber heads-up — only fires when the entry specifically
      // requested a barber (the matched one). "Any barber" entries
      // skip this so a slot match doesn't blast every barber's inbox.
      // The customer's email has already gone out by this point, so a
      // failure here is non-fatal and just logged. Same email-resolution
      // rules as the submit-time barber notification: account.email >
      // Square's TeamMember.email_address > skip.
      //
      // Reuses `picks` from earlier in the loop (declared right before
      // the availability search) — entries with no preference have
      // picks.length === 0, so the branch below skips naturally.
      const matchedBarberId = bestMatch.teamMemberId;
      const customerNamedThisBarber =
        !!matchedBarberId && picks.some((p) => p.id === matchedBarberId);
      if (customerNamedThisBarber && matchedBarberId) {
        try {
          const contact = await resolveBarberContact(matchedBarberId);
          if (contact) {
            const barberSend = await sendWaitlistSlotMatchBarber({
              to: contact.email,
              barberDisplayName: contact.displayName,
              customerName: entry.customerName,
              customerEmail: entry.customerEmail,
              customerPhone: entry.customerPhone,
              serviceName: entry.serviceName,
              whenLabel,
              dashboardUrl: `${origin}/barber/dashboard?tab=waitlist`,
              shopPhone: SHOP_PHONE,
            });
            logCron({
              phase: 'barber-notify-sent',
              entryId: entry.id,
              teamMemberId: matchedBarberId,
              inbox: redactEmail(contact.email),
              resendId: barberSend.id,
            });
          } else {
            logCron({
              phase: 'barber-notify-skipped-no-email',
              entryId: entry.id,
              teamMemberId: matchedBarberId,
            });
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          logCron({
            phase: 'barber-notify-failed',
            entryId: entry.id,
            teamMemberId: matchedBarberId,
            errorDetail: detail,
          });
        }
      }
    } catch (err) {
      const detail =
        err instanceof SquareApiError
          ? `${err.code}: ${err.detail}`
          : err instanceof Error
            ? err.message
            : String(err);
      stats.failures++;
      stats.failureDetails.push({ entryId: entry.id, reason: detail });
      logCron({
        phase: 'entry-failed',
        entryId: entry.id,
        email: redactEmail(entry.customerEmail),
        errorDetail: detail,
      });
      // Continue — one bad entry never crashes the whole batch.
    }
  }

  logCron({ phase: 'done', stats });
  return Response.json(stats, { status: 200 });
}

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
