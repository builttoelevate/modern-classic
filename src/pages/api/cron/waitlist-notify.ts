// Phase 8 — auto-notify waitlist cron.
//
// Runs every 30 min (vercel.json — cron entry added in a follow-up
// commit per the verification plan). For each active waitlist entry,
// fetches Square availability for that entry's (service, barber)
// combo across the customer's date window, runs the pure
// findMatchingSlot() filter, and emails them via Resend the moment
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
  listActiveWaitlistEntries,
  markWaitlistNotified,
  updateWaitlistStatus,
  type WaitlistEntry,
} from '../../../lib/marketing/waitlistLog';
import { findMatchingSlot, isWindowExpired } from '../../../lib/marketing/waitlistMatch';
import { searchAvailability } from '../../../lib/square/availability';
import { sendWaitlistOpening } from '../../../lib/email/resend';
import { formatRelativeSlot } from '../../../lib/availability/timing';
import { redactEmail } from '../../../lib/booking/log';
import { SquareApiError } from '../../../lib/square/client';
import type { AvailabilitySlot } from '../../../lib/square/types';

export const prerender = false;

const SHOP_ADDRESS = '819 Linden Avenue, Zanesville, OH 43701';
const SHOP_PHONE = '740-297-4462';

/** Square's availability endpoint caps each call at 31 days. We chunk the
 * customer's window into ≤30-day pieces so we never overshoot. */
const CHUNK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Bounded scan in case the cron has been off — never look further out
 * than this from "now" regardless of dateTo. Square only takes bookings
 * a couple of months ahead anyway. */
const MAX_HORIZON_DAYS = 90;

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

function searchWindowFor(entry: WaitlistEntry, now: Date): { startAt: Date; endAt: Date } | null {
  // Lower bound: max(now, dateFrom local-midnight). We don't need to
  // search before "now" since past slots aren't bookable.
  const nowMs = now.getTime();
  let startMs = nowMs;
  if (entry.dateFrom) {
    const fromMs = Date.parse(`${entry.dateFrom}T00:00:00`);
    if (Number.isFinite(fromMs) && fromMs > nowMs) startMs = fromMs;
  }
  // Upper bound: min(now + MAX_HORIZON_DAYS, dateTo local-end-of-day).
  let endMs = nowMs + MAX_HORIZON_DAYS * DAY_MS;
  if (entry.dateTo) {
    const toMs = Date.parse(`${entry.dateTo}T23:59:59`);
    if (Number.isFinite(toMs) && toMs < endMs) endMs = toMs;
  }
  if (endMs <= startMs) return null;
  return { startAt: new Date(startMs), endAt: new Date(endMs) };
}

async function searchAvailabilityChunked(
  serviceVariationId: string,
  teamMemberId: string | undefined,
  startAt: Date,
  endAt: Date,
): Promise<AvailabilitySlot[]> {
  const out: AvailabilitySlot[] = [];
  let cursor = startAt.getTime();
  const endMs = endAt.getTime();
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_DAYS * DAY_MS, endMs);
    const slots = await searchAvailability({
      serviceVariationId,
      teamMemberId,
      startAt: new Date(cursor),
      endAt: new Date(chunkEnd),
    });
    out.push(...slots);
    cursor = chunkEnd;
    // Short-circuit — once we have a candidate, the matcher only needs
    // the earliest slot. Don't burn extra Square calls.
    if (out.length > 0) break;
  }
  return out;
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

      const slots = await searchAvailabilityChunked(
        entry.serviceVariationId,
        entry.teamMemberId ?? undefined,
        window.startAt,
        window.endAt,
      );

      const match = findMatchingSlot(entry, slots, now);
      if (!match) {
        stats.skipped.noSlotsInWindow++;
        continue;
      }

      stats.matched++;
      const whenLabel = formatRelativeSlot(match.startAtUtc);
      const bookParams = new URLSearchParams();
      if (entry.serviceVariationId) bookParams.set('service', entry.serviceVariationId);
      if (entry.teamMemberId) bookParams.set('barber', entry.teamMemberId);
      const bookUrl = `${origin}/book${bookParams.toString() ? `?${bookParams.toString()}` : ''}`;

      if (dryRun) {
        logCron({
          phase: 'dry-run-would-send',
          entryId: entry.id,
          email: redactEmail(entry.customerEmail),
          slot: match.startAtUtc,
          whenLabel,
        });
        stats.sent++;
        continue;
      }

      const sendResult = await sendWaitlistOpening({
        to: entry.customerEmail,
        customerName: entry.customerName,
        barberName: entry.barberName,
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
