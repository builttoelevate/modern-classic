import type { APIRoute } from 'astro';
import { searchAvailability } from '../../../lib/square/availability';
import { SquareApiError } from '../../../lib/square/client';

export const prerender = false;

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: { code: 'BAD_REQUEST', detail: message } }, { status: 400 });
}

export const GET: APIRoute = async ({ url }) => {
  const params = url.searchParams;
  const serviceVariationId = params.get('serviceVariationId') ?? '';
  const teamMemberId = params.get('teamMemberId');
  const startAtRaw = params.get('startAt') ?? '';
  const endAtRaw = params.get('endAt') ?? '';

  if (!serviceVariationId) return badRequest('serviceVariationId is required');
  if (!startAtRaw) return badRequest('startAt is required (ISO UTC)');
  if (!endAtRaw) return badRequest('endAt is required (ISO UTC)');

  const startAt = new Date(startAtRaw);
  const endAt = new Date(endAtRaw);
  if (isNaN(startAt.getTime())) return badRequest('startAt is not a valid ISO date');
  if (isNaN(endAt.getTime())) return badRequest('endAt is not a valid ISO date');

  try {
    const slots = await searchAvailability({
      serviceVariationId,
      teamMemberId: teamMemberId && teamMemberId.trim() ? teamMemberId : undefined,
      startAt,
      endAt,
    });
    return Response.json({ ok: true, slots }, { status: 200 });
  } catch (err) {
    if (err instanceof SquareApiError) {
      return Response.json(
        { ok: false, error: { code: err.code, detail: err.detail } },
        { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
      );
    }
    if (err instanceof Error) return badRequest(err.message);
    return Response.json({ ok: false, error: { code: 'INTERNAL', detail: 'Unknown error' } }, { status: 500 });
  }
};
