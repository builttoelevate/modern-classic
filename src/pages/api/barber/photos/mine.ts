// GET /api/barber/photos/mine — list this barber's gallery uploads
// so the /barber/dashboard can show them with Delete buttons.
//
// The result is filtered by pathname prefix (gallery/{barberId}/)
// — a barber can never see another barber's blobs through this
// endpoint. Reuses the same listGalleryPhotos helper /gallery
// uses; we just filter client-side here for simplicity.

import type { APIRoute } from 'astro';
import {
  BarberAuthRequiredError,
  refreshBarberSessionCookie,
  requireBarberSession,
} from '../../../../lib/auth/barberMiddleware';
import {
  GALLERY_PREFIX,
  listGalleryPhotos,
} from '../../../../lib/gallery/blobPhotos';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }
  const prefix = `${GALLERY_PREFIX}${session.barberId}/`;
  const all = await listGalleryPhotos();
  const mine = all.filter((p) => p.pathname.startsWith(prefix));
  return new Response(
    JSON.stringify({ ok: true, photos: mine }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshBarberSessionCookie(session),
      },
    },
  );
};
