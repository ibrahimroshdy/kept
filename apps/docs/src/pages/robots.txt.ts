/**
 * robots.txt: every page may be crawled except Try Kept's app (D246, /try/kept/app/: the web app's
 * demo build, a page of its own that is noindex anyway), and the sitemap is named. The sitemap
 * (@astrojs/sitemap, sitemap-index.xml, astro.config.mjs) is written only when the build knows its
 * site (KEPT_DOCS_SITE), so a build without one names none. Any other page that shouldn't be
 * indexed says so itself with a robots meta tag (only the 404 page, src/route-data.ts).
 */
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const lines = ['User-agent: *', 'Allow: /', `Disallow: ${base}/try/kept/app/`];
  if (site) lines.push('', `Sitemap: ${new URL(`${base}/sitemap-index.xml`, site).href}`);
  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
