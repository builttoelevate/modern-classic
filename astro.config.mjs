import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';
import node from '@astrojs/node';

// Build target matrix:
//   default (Vercel)        -> output: 'server', vercel adapter, runs SSR.
//   DEPLOY_TARGET=gh-pages  -> output: 'static', no adapter, and the
//                              gh-pages workflow rm's the Vercel-only
//                              routes (src/pages/api, /admin, /book.astro)
//                              before invoking `astro build`.
//   DEPLOY_TARGET=local-preview -> output: 'server', Node adapter, used
//                              by Lighthouse runs locally (since the
//                              Vercel adapter doesn't support `astro
//                              preview`).
const isGhPages = process.env.DEPLOY_TARGET === 'gh-pages';
const isLocalPreview = process.env.DEPLOY_TARGET === 'local-preview';
const SITE = isGhPages
  ? `https://${process.env.GH_OWNER ?? 'builttoelevate'}.github.io`
  : 'https://mdrnclassic.com';
const BASE = isGhPages
  ? `/${process.env.GH_REPO ?? 'modern-classic'}`
  : undefined;

export default defineConfig({
  site: SITE,
  base: BASE,
  output: isGhPages ? 'static' : 'server',
  adapter: isGhPages
    ? undefined
    : isLocalPreview
      ? node({ mode: 'standalone' })
      : vercel({
          // Route Astro's <Image /> through Vercel's Image Optimization
          // API rather than the default sharp service. Without this the
          // serverless function's image URLs fail at runtime and the hero
          // logo + background render as broken-image placeholders.
          imageService: true,
          imagesConfig: {
            sizes: [320, 480, 640, 720, 1080, 1280, 1440, 1600, 1920],
            domains: ['mdrnclassic.com'],
            formats: ['image/webp'],
          },
        }),
  trailingSlash: 'ignore',
  build: {
    inlineStylesheets: 'auto',
  },
  image: {
    domains: ['mdrnclassic.com'],
  },
  integrations: [react()],
});
