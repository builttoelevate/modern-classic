// POST /api/barber/photos/delete — remove a gallery blob.
//
// Body: { pathname: string }  — the blob's pathname (e.g.
// "gallery/{teamMemberId}/{ts}-{rand}.jpg"). The endpoint refuses
// any pathname that doesn't start with this caller's
// gallery/{barberId}/ prefix, so a barber can only delete photos
// they uploaded themselves.

import type { APIRoute } from 'astro';
import { del } from '@vercel/blob';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import {
  GALLERY_PREFIX,
  invalidateGalleryCache,
} from '../../../../lib/gallery/blobPhotos';

export const prerender = false;

function logBarber(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

interface RequestBody {
  pathname?: string;
}

export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const b = (body ?? {}) as RequestBody;
  const pathname = typeof b.pathname === 'string' ? b.pathname.trim() : '';
  if (!pathname) return fail(400, 'BAD_REQUEST', 'pathname is required.');

  const ownPrefix = `${GALLERY_PREFIX}${session.barberId}/`;
  if (!pathname.startsWith(ownPrefix)) {
    // Either a tampered pathname pointing at another barber's
    // photo, or a malformed value. Refuse rather than leak.
    logBarber({
      phase: 'gallery-photo-delete-forbidden',
      barberId: session.barberId,
      pathname,
    });
    return fail(
      403,
      'NOT_YOUR_PHOTO',
      "You can only delete photos you uploaded yourself.",
    );
  }

  try {
    await del(pathname);
    await invalidateGalleryCache();
    logBarber({
      phase: 'gallery-photo-deleted',
      barberId: session.barberId,
      username: session.username,
      pathname,
    });
    return new Response(
      JSON.stringify({ ok: true, pathname }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshBarberSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown delete error.';
    logBarber({
      phase: 'gallery-photo-delete-failed',
      barberId: session.barberId,
      pathname,
      detail,
    });
    return fail(502, 'DELETE_FAILED', detail);
  }
};
