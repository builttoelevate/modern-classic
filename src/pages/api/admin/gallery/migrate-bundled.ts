// POST /api/admin/gallery/migrate-bundled — one-time (idempotent)
// migration of the bundled src/assets/gallery/*.jpg into Vercel
// Blob under gallery/curated/{basename}.jpg. Triggered by a button
// in /admin/gallery.
//
// Idempotency: we head() each target pathname before writing, so a
// re-run skips files already in Blob. Safe to invoke repeatedly.
//
// Why the bundled paths can be read at runtime: Astro's
// import.meta.glob bundles the matched JPGs into the function
// deployment with hashed URLs accessible at the deploy's own
// origin. The endpoint fetches each via that URL (constructed
// from the request URL) and forwards the bytes to put().

import type { APIRoute } from 'astro';
import { head, put } from '@vercel/blob';
import { checkBasicAuth } from '../../../../lib/admin/auth';
import {
  CURATED_BARBER_ID,
  GALLERY_PREFIX,
  invalidateGalleryCache,
} from '../../../../lib/gallery/blobPhotos';

export const prerender = false;

function logAdmin(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[ADMIN] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

// Astro's import.meta.glob is provided by Vite; the standard
// ImportMeta type doesn't know about it, so we cast for TS while
// keeping the Astro/Vite runtime behaviour identical. Each entry's
// default export is an Astro ImageMetadata-shaped object — we only
// need `src` here, so a minimal local shape is fine.
interface BundledAsset {
  src: string;
}
const imageModules = (
  import.meta as unknown as {
    glob: <T>(
      pattern: string,
      opts: { eager: true; import: 'default' },
    ) => Record<string, T>;
  }
).glob<BundledAsset>('../../../../assets/gallery/*.jpg', {
  eager: true,
  import: 'default',
});

interface MigrateResult {
  filename: string;
  pathname: string;
  status: 'migrated' | 'skipped' | 'failed';
  detail?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const auth = checkBasicAuth(request);
  if (!auth.ok) return auth.challenge;

  const entries = Object.entries(imageModules);
  const results: MigrateResult[] = [];
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [path, meta] of entries) {
    const filename = path.split('/').pop() ?? '';
    if (!filename) continue;
    const targetPathname = `${GALLERY_PREFIX}${CURATED_BARBER_ID}/${filename}`;

    // Skip if already in Blob. head() throws when not found, so
    // a non-throw means present.
    let exists = false;
    try {
      await head(targetPathname);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      skipped++;
      results.push({ filename, pathname: targetPathname, status: 'skipped' });
      continue;
    }

    try {
      const sourceUrl = new URL(meta.src, request.url).toString();
      const res = await fetch(sourceUrl);
      if (!res.ok) {
        throw new Error(`Could not fetch bundled asset (${res.status}).`);
      }
      const bytes = await res.arrayBuffer();
      await put(targetPathname, bytes, {
        access: 'public',
        contentType: 'image/jpeg',
        addRandomSuffix: false,
      });
      migrated++;
      results.push({ filename, pathname: targetPathname, status: 'migrated' });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failed++;
      results.push({ filename, pathname: targetPathname, status: 'failed', detail });
      logAdmin({
        phase: 'admin-gallery-migrate-asset-failed',
        filename,
        pathname: targetPathname,
        detail,
      });
    }
  }

  if (migrated > 0) {
    await invalidateGalleryCache();
  }

  logAdmin({
    phase: 'admin-gallery-migrate-done',
    total: entries.length,
    migrated,
    skipped,
    failed,
  });

  return Response.json({
    ok: true,
    total: entries.length,
    migrated,
    skipped,
    failed,
    results,
  });
};
