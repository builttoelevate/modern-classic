// POST /api/admin/gallery/delete — admin-side gallery blob removal.
//
// Unlike the barber-side delete (which restricts each barber to
// their own gallery/{barberId}/ prefix), admin can delete ANY blob
// under gallery/. Used by the /admin/gallery management surface to
// clean up curated photos or any barber's uploads.

import type { APIRoute } from 'astro';
import { del } from '@vercel/blob';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  GALLERY_PREFIX,
  invalidateGalleryCache,
} from '../../../../lib/gallery/blobPhotos';

export const prerender = false;

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

interface RequestBody {
  pathname?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const b = (body ?? {}) as RequestBody;
  const pathname = typeof b.pathname === 'string' ? b.pathname.trim() : '';
  if (!pathname) return fail(400, 'BAD_REQUEST', 'pathname is required.');

  // Defence: only allow deleting things under gallery/ so a
  // tampered request can't reach into unrelated blob namespaces.
  if (!pathname.startsWith(GALLERY_PREFIX)) {
    return fail(
      400,
      'OUT_OF_SCOPE',
      `pathname must start with "${GALLERY_PREFIX}".`,
    );
  }

  try {
    await del(pathname);
    await invalidateGalleryCache();
    logAdmin({ phase: 'admin-gallery-photo-deleted', pathname });
    return Response.json({ ok: true, pathname });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown delete error.';
    logAdmin({ phase: 'admin-gallery-photo-delete-failed', pathname, detail });
    return fail(502, 'DELETE_FAILED', detail);
  }
};
