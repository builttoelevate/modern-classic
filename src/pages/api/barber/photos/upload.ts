// POST /api/barber/photos/upload — barber-side photo upload to the
// public Modern Classic gallery.
//
// Body: multipart/form-data with field `photo` (the image binary,
// already client-side resized + JPEG-encoded to keep payloads small
// and consistent — see the dashboard upload script). Server still
// validates content-type + size as the second line of defense.
//
// Storage: Vercel Blob at `gallery/{barberId}/{timestamp}-{rand}.jpg`.
// The barberId prefix is the only piece of structure — no filename
// echo, no captions, no metadata sidecar. Reversible: future code
// can ignore the prefix and treat blobs as a flat list. Today's
// /gallery listing already does exactly that.

import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';
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

// 10 MB. Client resizes to ~1-2 MB before posting; this cap is for
// the rare case where the client-side resize fails open or someone
// hits the endpoint directly.
const MAX_BYTES = 10 * 1024 * 1024;

// Accepts JPEG / PNG / WebP. The client tries to normalize to JPEG
// (canvas resize + EXIF strip), but iOS Safari occasionally throws
// DOMException for PNG/HEIC variants with unusual color profiles or
// transparency. The client falls back to uploading the original
// file when normalize throws, so the server has to accept what
// browsers can render natively. /gallery renders every supported
// format via plain <img> tags so there's no per-format branching
// on the read side.
const ACCEPTED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function extensionForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function logBarber(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[BARBER] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

function randomHex(bytes: number): string {
  const u8 = new Uint8Array(bytes);
  crypto.getRandomValues(u8);
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const POST: APIRoute = async ({ request }) => {
  let session;
  try {
    session = requireBarberSession(request);
  } catch (err) {
    if (err instanceof BarberAuthRequiredError) return err.response;
    throw err;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be multipart/form-data.');
  }

  const file = form.get('photo');
  if (!(file instanceof File)) {
    return fail(400, 'BAD_REQUEST', 'Field "photo" is required and must be a file.');
  }
  if (file.size === 0) {
    return fail(400, 'EMPTY_FILE', 'Photo is empty.');
  }
  if (file.size > MAX_BYTES) {
    return fail(
      413,
      'TOO_LARGE',
      `Photo is too large (${Math.round(file.size / 1024 / 1024)}MB). Max is ${MAX_BYTES / 1024 / 1024}MB.`,
    );
  }
  if (!ACCEPTED_MIME.has(file.type)) {
    return fail(
      415,
      'WRONG_TYPE',
      `This format isn't supported (${file.type || 'unknown'}). Save the photo as JPEG or PNG and try again.`,
    );
  }

  const ts = Date.now();
  const ext = extensionForMime(file.type);
  const pathname = `${GALLERY_PREFIX}${session.barberId}/${ts}-${randomHex(4)}.${ext}`;

  try {
    const blob = await put(pathname, file, {
      access: 'public',
      contentType: file.type,
      // Defensive: addRandomSuffix would change our chosen pathname.
      // Our own ts+random gives uniqueness without losing the
      // barberId-prefix structure.
      addRandomSuffix: false,
    });

    await invalidateGalleryCache();

    logBarber({
      phase: 'gallery-photo-uploaded',
      barberId: session.barberId,
      username: session.username,
      pathname: blob.pathname,
      sizeBytes: file.size,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        photo: {
          url: blob.url,
          pathname: blob.pathname,
          sizeBytes: file.size,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': refreshBarberSessionCookie(session),
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown upload error.';
    logBarber({
      phase: 'gallery-photo-upload-failed',
      barberId: session.barberId,
      detail,
    });
    return fail(502, 'UPLOAD_FAILED', detail);
  }
};
