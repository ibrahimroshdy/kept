/**
 * robots.txt: every page may be indexed, and the sitemap is named. Starlight writes the sitemap
 * (@astrojs/sitemap, sitemap-index.xml) only when the build knows its site (KEPT_DOCS_SITE), so a
 * build without one names none. Pages that shouldn't be indexed say so themselves (a robots
 * meta tag in their frontmatter, as try/map does while it is a placeholder).
 */
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const lines = ['User-agent: *', 'Allow: /'];
  if (site) lines.push('', `Sitemap: ${new URL(`${base}/sitemap-index.xml`, site).href}`);
  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
