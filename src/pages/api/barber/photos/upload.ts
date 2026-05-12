// POST /api/barber/photos/upload — barber-side photo upload to the
// public Modern Classic gallery.
//
// Body: raw image bytes (Content-Type set on the request — e.g.
// `image/jpeg`, `image/png`, `image/webp`). Previously this took
// multipart/form-data, but iOS Safari's multipart encoder
// occasionally threw DOMException ("The string did not match the
// expected pattern.") on lazy iOS Photos File objects, which
// surfaced to the user as a cryptic upload failure. Reading the
// raw body skips that whole encoder.
//
// Storage: Vercel Blob at `gallery/{barberId}/{timestamp}-{rand}.{ext}`.
// Extension is derived from the content-type so the served URL has
// the right suffix for caching + content sniffing.

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

  // Parse the content-type header. Some browsers tack on params
  // ("image/jpeg; charset=…") even when not meaningful — strip them.
  const rawCt = request.headers.get('content-type') ?? '';
  const mime = rawCt.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime) {
    return fail(400, 'NO_CONTENT_TYPE', 'Missing Content-Type header.');
  }
  if (!ACCEPTED_MIME.has(mime)) {
    return fail(
      415,
      'WRONG_TYPE',
      `This format isn't supported (${mime}). Save the photo as JPEG or PNG and try again.`,
    );
  }

  // Cheap early-exit via Content-Length so we don't have to read a
  // huge body before rejecting. Browsers always send Content-Length
  // for a Blob/File body.
  const contentLengthHeader = request.headers.get('content-length');
  const announced = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(announced) && announced > MAX_BYTES) {
    return fail(
      413,
      'TOO_LARGE',
      `Photo is too large (${Math.round(announced / 1024 / 1024)}MB). Max is ${MAX_BYTES / 1024 / 1024}MB.`,
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Could not read upload.';
    logBarber({
      phase: 'gallery-photo-read-failed',
      barberId: session.barberId,
      mime,
      detail,
    });
    return fail(400, 'READ_FAILED', detail);
  }

  if (bytes.byteLength === 0) {
    return fail(400, 'EMPTY_FILE', 'Photo is empty.');
  }
  if (bytes.byteLength > MAX_BYTES) {
    return fail(
      413,
      'TOO_LARGE',
      `Photo is too large (${Math.round(bytes.byteLength / 1024 / 1024)}MB). Max is ${MAX_BYTES / 1024 / 1024}MB.`,
    );
  }

  const ts = Date.now();
  const ext = extensionForMime(mime);
  const pathname = `${GALLERY_PREFIX}${session.barberId}/${ts}-${randomHex(4)}.${ext}`;

  try {
    const blob = await put(pathname, bytes, {
      access: 'public',
      contentType: mime,
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
      mime,
      sizeBytes: bytes.byteLength,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        photo: {
          url: blob.url,
          pathname: blob.pathname,
          sizeBytes: bytes.byteLength,
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
      pathname,
      mime,
      sizeBytes: bytes.byteLength,
      detail,
    });
    return fail(502, 'UPLOAD_FAILED', detail);
  }
};
