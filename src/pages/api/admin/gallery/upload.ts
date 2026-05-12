// POST /api/admin/gallery/upload — admin-side photo upload to the
// public gallery's "curated" namespace.
//
// Same raw-body shape as the barber-side upload (PR #110) — Content-
// Type carries the MIME, body is the image bytes. Differs only in
// the storage prefix: `gallery/curated/{ts}-{rand}.{ext}` instead
// of per-barber. Admin auth via HTTP Basic Auth, matching the
// pattern every /api/admin endpoint uses.

import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  CURATED_BARBER_ID,
  GALLERY_PREFIX,
  invalidateGalleryCache,
} from '../../../../lib/gallery/blobPhotos';

export const prerender = false;

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

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
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
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  const rawCt = request.headers.get('content-type') ?? '';
  const mime = rawCt.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime) return fail(400, 'NO_CONTENT_TYPE', 'Missing Content-Type header.');
  if (!ACCEPTED_MIME.has(mime)) {
    return fail(
      415,
      'WRONG_TYPE',
      `This format isn't supported (${mime}). Save the photo as JPEG, PNG, or WebP and try again.`,
    );
  }

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
    logAdmin({ phase: 'admin-gallery-read-failed', mime, detail });
    return fail(400, 'READ_FAILED', detail);
  }
  if (bytes.byteLength === 0) return fail(400, 'EMPTY_FILE', 'Photo is empty.');
  if (bytes.byteLength > MAX_BYTES) {
    return fail(
      413,
      'TOO_LARGE',
      `Photo is too large (${Math.round(bytes.byteLength / 1024 / 1024)}MB). Max is ${MAX_BYTES / 1024 / 1024}MB.`,
    );
  }

  const ts = Date.now();
  const ext = extensionForMime(mime);
  const pathname = `${GALLERY_PREFIX}${CURATED_BARBER_ID}/${ts}-${randomHex(4)}.${ext}`;

  try {
    const blob = await put(pathname, bytes, {
      access: 'public',
      contentType: mime,
      addRandomSuffix: false,
    });
    await invalidateGalleryCache();
    logAdmin({
      phase: 'admin-gallery-photo-uploaded',
      pathname: blob.pathname,
      mime,
      sizeBytes: bytes.byteLength,
    });
    return Response.json({
      ok: true,
      photo: {
        url: blob.url,
        pathname: blob.pathname,
        sizeBytes: bytes.byteLength,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unknown upload error.';
    logAdmin({
      phase: 'admin-gallery-photo-upload-failed',
      pathname,
      mime,
      sizeBytes: bytes.byteLength,
      detail,
    });
    return fail(502, 'UPLOAD_FAILED', detail);
  }
};
