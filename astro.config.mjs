import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://mdrnclassic.com',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    inlineStylesheets: 'auto',
  },
  image: {
    domains: ['mdrnclassic.com'],
  },
});
