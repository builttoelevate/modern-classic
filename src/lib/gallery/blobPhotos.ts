// Gallery photos uploaded by barbers, listed from Vercel Blob.
//
// Photos are stored under `gallery/{barberId}/{timestamp}-{rand}.jpg`
// so future surfaces ("filter the gallery by Michael's work") can
// pull the prefix out of the pathname without a schema migration.
// For v1, /gallery just lists everything under `gallery/` and
// renders newest-first.
//
// Listing happens at SSR render time on /gallery, which is a public
// page that gets meaningful traffic — so we cache the resolved list
// in Redis for 60s. Upload endpoint invalidates the key on success
// so a barber sees their new photo appear the moment they navigate
// to /gallery; only "cold" page renders (no recent upload) hit blob
// list. 60s is short enough that a manual edit in the Vercel
// console would still propagate fast.

import { list, type ListBlobResultBlob } from '@vercel/blob';
import { Redis } from '@upstash/redis';

export const GALLERY_PREFIX = 'gallery/';
const CACHE_KEY = 'mc:gallery:blob-list:v1';
const CACHE_TTL_SECONDS = 60;

// Tombstone set for bundled-asset filenames the operator has hidden
// from the public /gallery. Without this, deleting a Blob curated
// photo whose filename matches a bundled JPG silently re-surfaces
// the bundled version (the public gallery's dedup logic only hides
// bundled photos that are STILL in Blob curated). The tombstone is
// the missing "stay hidden" signal.
export const BUNDLED_TOMBSTONES_KEY = 'mc:gallery:bundled-tombstones';

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (typeof window !== 'undefined') return null;
  const url =
    import.meta.env.UPSTASH_REDIS_REST_URL ??
    import.meta.env.KV_REST_API_URL ??
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.KV_REST_API_URL;
  const token =
    import.meta.env.UPSTASH_REDIS_REST_TOKEN ??
    import.meta.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url: String(url), token: String(token) });
  return _redis;
}

export const CURATED_BARBER_ID = 'curated';

export interface GalleryBlobPhoto {
  /** Public HTTPS URL served by Vercel Blob. */
  url: string;
  /** Blob pathname like `gallery/{barberId}/{ts}-{rand}.jpg`, or
   *  `gallery/curated/{filename}.jpg` for admin-uploaded "house
   *  picks" migrated out of the bundled src/assets/gallery set. */
  pathname: string;
  /** Parsed second-segment from the pathname (the barber's team id
   *  for per-barber uploads, the literal "curated" for admin
   *  uploads, or empty when the pathname is malformed). */
  barberId: string;
  /** Higher-level source discriminator derived from the pathname.
   *  Lets surfaces ignore the raw barberId string and just branch
   *  on a stable kind. */
  kind: 'curated' | 'barber';
  /** ISO timestamp from blob metadata. */
  uploadedAt: string;
  /** Bytes — useful for the dashboard to show a per-barber total. */
  sizeBytes: number;
}

function pathToBarberId(pathname: string): string {
  if (!pathname.startsWith(GALLERY_PREFIX)) return '';
  const rest = pathname.slice(GALLERY_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(0, slash);
}

function toPhoto(blob: ListBlobResultBlob): GalleryBlobPhoto {
  const barberId = pathToBarberId(blob.pathname);
  return {
    url: blob.url,
    pathname: blob.pathname,
    barberId,
    kind: barberId === CURATED_BARBER_ID ? 'curated' : 'barber',
    uploadedAt: blob.uploadedAt instanceof Date
      ? blob.uploadedAt.toISOString()
      : String(blob.uploadedAt ?? ''),
    sizeBytes: blob.size ?? 0,
  };
}

/**
 * List every gallery blob, newest first. Returns [] on any failure
 * so /gallery still renders the bundled curated photos when blob
 * or Redis is unhealthy.
 */
export async function listGalleryPhotos(): Promise<GalleryBlobPhoto[]> {
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get<GalleryBlobPhoto[]>(CACHE_KEY);
      if (cached) return cached;
    } catch {
      // Redis miss / hiccup — fall through to live blob list.
    }
  }

  let blobs: ListBlobResultBlob[] = [];
  try {
    let cursor: string | undefined;
    do {
      const res = await list({ prefix: GALLERY_PREFIX, cursor, limit: 1000 });
      blobs = blobs.concat(res.blobs);
      cursor = res.cursor;
    } while (cursor);
  } catch {
    // No token, network blip, etc. /gallery degrades to bundled-only.
    return [];
  }

  const photos = blobs
    .map(toPhoto)
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));

  if (redis) {
    try {
      await redis.set(CACHE_KEY, photos, { ex: CACHE_TTL_SECONDS });
    } catch {
      // Non-fatal — next render does a live list.
    }
  }

  return photos;
}

/**
 * Drop the cache so the next /gallery render reads the live blob
 * list. Called by the upload endpoint on successful upload so a
 * barber sees their new photo the moment they navigate to /gallery,
 * not 60s later.
 */
export async function invalidateGalleryCache(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(CACHE_KEY);
  } catch {
    // Non-fatal — cache will TTL out within 60s anyway.
  }
}

/**
 * Returns the set of bundled-asset filenames that should NOT render
 * on the public /gallery, even if they're not present in Blob.
 * Returns an empty Set on any failure (fail-open — better to show a
 * photo than to hide everything because Redis blipped).
 */
export async function listBundledTombstones(): Promise<Set<string>> {
  const redis = getRedis();
  if (!redis) return new Set<string>();
  try {
    const members = (await redis.smembers(BUNDLED_TOMBSTONES_KEY)) as string[];
    return new Set(members);
  } catch {
    return new Set<string>();
  }
}

/** Adds a bundled filename (e.g. "mc002.jpg") to the tombstone set so
 *  the public /gallery stops rendering it. Idempotent. */
export async function hideBundledFilename(filename: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.sadd(BUNDLED_TOMBSTONES_KEY, filename);
  await invalidateGalleryCache();
}

/** Removes a bundled filename from the tombstone set so the public
 *  /gallery starts rendering it again. Idempotent. */
export async function unhideBundledFilename(filename: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.srem(BUNDLED_TOMBSTONES_KEY, filename);
  await invalidateGalleryCache();
}
