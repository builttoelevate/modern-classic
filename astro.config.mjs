import { defineConfig } from 'astro/config';

// When DEPLOY_TARGET=gh-pages we publish to https://<owner>.github.io/<repo>/
// (see .github/workflows/deploy.yml). Otherwise this is a production build
// for mdrnclassic.com (or a Vercel preview) and lives at the domain root.
const isGhPages = process.env.DEPLOY_TARGET === 'gh-pages';
const SITE = isGhPages
  ? `https://${process.env.GH_OWNER ?? 'builttoelevate'}.github.io`
  : 'https://mdrnclassic.com';
const BASE = isGhPages
  ? `/${process.env.GH_REPO ?? 'modern-classic'}`
  : undefined;

export default defineConfig({
  site: SITE,
  base: BASE,
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    inlineStylesheets: 'auto',
  },
  image: {
    domains: ['mdrnclassic.com'],
  },
});
