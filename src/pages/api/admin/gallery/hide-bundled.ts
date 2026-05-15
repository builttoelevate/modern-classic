// POST /api/admin/gallery/hide-bundled — hide or restore one of the
// 28 bundled gallery photos (src/assets/gallery/*.jpg) on the public
// /gallery without touching Vercel Blob.
//
// Body: { filename: "mc002.jpg", hidden: true }    → hide
//       { filename: "mc002.jpg", hidden: false }   → restore
//
// Why this exists: bundled photos are baked into the build by
// Astro's import.meta.glob. There's no Blob URL to delete; the only
// way to suppress them on /gallery is a tombstone in Redis. Without
// this endpoint a non-coding operator (Michael, Bill on a phone)
// has no way to remove a bundled photo from the public gallery.

import type { APIRoute } from 'astro';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  hideBundledFilename,
  unhideBundledFilename,
} from '../../../../lib/gallery/blobPhotos';

export const prerender = false;

const bundledImageModules = (
  import.meta as unknown as {
    glob: <T>(
      pattern: string,
      opts: { eager: true; import: 'default' },
    ) => Record<string, T>;
  }
).glob<unknown>('../../../../assets/gallery/*.jpg', { eager: true, import: 'default' });
const KNOWN_BUNDLED = new Set<string>(
  Object.keys(bundledImageModules).map((p) => p.split('/').pop() ?? ''),
);

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ ok: false, error: { code, detail } }, { status });
}

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  let body: { filename?: unknown; hidden?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, 'BAD_REQUEST', 'Body must be valid JSON.');
  }
  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  if (!filename) {
    return fail(400, 'BAD_REQUEST', 'filename is required.');
  }
  if (!KNOWN_BUNDLED.has(filename)) {
    return fail(
      400,
      'NOT_BUNDLED',
      `"${filename}" is not a known bundled gallery photo. To delete a Blob photo, use /api/admin/gallery/delete instead.`,
    );
  }
  const hidden = body.hidden !== false; // default to hide

  try {
    if (hidden) {
      await hideBundledFilename(filename);
    } else {
      await unhideBundledFilename(filename);
    }
    logAdmin({
      phase: hidden ? 'admin-gallery-bundled-hidden' : 'admin-gallery-bundled-restored',
      filename,
    });
    return Response.json({ ok: true, filename, hidden });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logAdmin({
      phase: 'admin-gallery-bundled-toggle-failed',
      filename,
      hidden,
      detail,
    });
    return fail(500, 'INTERNAL', detail);
  }
};
