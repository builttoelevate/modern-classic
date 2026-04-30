import type { APIRoute } from 'astro';

// Static sitemap. Pages added under src/pages/ should be appended here so
// they get indexed. Lastmod uses the build timestamp — accurate enough for
// a low-frequency-update marketing site.
const routes: { path: string; priority: number; changefreq: string }[] = [
  { path: '/',         priority: 1.0, changefreq: 'monthly' },
  { path: '/services', priority: 0.9, changefreq: 'monthly' },
  { path: '/shop',     priority: 0.9, changefreq: 'weekly'  },
  { path: '/gallery',  priority: 0.8, changefreq: 'weekly'  },
  { path: '/barbers',  priority: 0.8, changefreq: 'monthly' },
  { path: '/visit',    priority: 0.8, changefreq: 'monthly' },
];

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://mdrnclassic.com')).origin;
  const lastmod = new Date().toISOString().slice(0, 10);

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    routes
      .map(
        (r) =>
          `  <url>\n` +
          `    <loc>${origin}${r.path}</loc>\n` +
          `    <lastmod>${lastmod}</lastmod>\n` +
          `    <changefreq>${r.changefreq}</changefreq>\n` +
          `    <priority>${r.priority.toFixed(1)}</priority>\n` +
          `  </url>`
      )
      .join('\n') +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
