import type { APIRoute } from 'astro';
import { searchAvailability } from '../../../lib/square/availability';
import { cached } from '../../../lib/availability/cache';
import { SquareApiError } from '../../../lib/square/client';
import type { AvailabilitySlot } from '../../../lib/square/types';

export const prerender = false;

const CACHE_TTL_SECONDS = 600;
const SEARCH_WINDOW_DAYS = 60;
const CHUNK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function badRequest(message: string): Response {
  return Response.json(
    { ok: false, error: { code: 'BAD_REQUEST', detail: message } },
    { status: 400 },
  );
}

async function findSoonest(
  serviceVariationIds: string[],
  teamMemberId: string | undefined,
): Promise<AvailabilitySlot | null> {
  const now = Date.now();
  const horizon = now + SEARCH_WINDOW_DAYS * DAY_MS;
  const chunks: { startAt: Date; endAt: Date }[] = [];
  let cursor = now;
  while (cursor < horizon) {
    const next = Math.min(cursor + CHUNK_DAYS * DAY_MS, horizon);
    chunks.push({ startAt: new Date(cursor), endAt: new Date(next) });
    cursor = next;
  }

  // Walk chunks in order so we can short-circuit as soon as one returns
  // a slot — no need to ping Square for further-out windows.
  for (const chunk of chunks) {
    const all = await Promise.all(
      serviceVariationIds.map((id) =>
        searchAvailability({
          serviceVariationId: id,
          teamMemberId,
          startAt: chunk.startAt,
          endAt: chunk.endAt,
        }).catch(() => [] as AvailabilitySlot[]),
      ),
    );
    let soonest: AvailabilitySlot | null = null;
    for (const slots of all) {
      for (const s of slots) {
        if (!soonest || s.startAtUtc < soonest.startAtUtc) soonest = s;
      }
    }
    if (soonest) return soonest;
  }
  return null;
}

export const GET: APIRoute = async ({ url }) => {
  const params = url.searchParams;
  // Allow comma-separated `serviceVariationId` for "Any barber" service
  // pickers that fan out across N per-barber variations.
  const raw = params.getAll('serviceVariationId').flatMap((s) => s.split(','));
  const serviceVariationIds = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  const teamMemberId = params.get('teamMemberId')?.trim() || undefined;

  if (serviceVariationIds.length === 0) {
    return badRequest('serviceVariationId is required');
  }

  const cacheKey = `next-avail-search:${serviceVariationIds.slice().sort().join(',')}:${teamMemberId ?? 'any'}`;

  try {
    const slot = await cached(cacheKey, CACHE_TTL_SECONDS, () =>
      findSoonest(serviceVariationIds, teamMemberId),
    );
    return Response.json({ ok: true, slot }, { status: 200 });
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail } },
        { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
      );
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return Response.json(
      { ok: false, error: { code: 'INTERNAL', detail } },
      { status: 500 },
    );
  }
};
