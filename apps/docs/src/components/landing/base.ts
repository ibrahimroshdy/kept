/**
 * Site paths (`/install/compose/`) with the base path in front. GitHub Pages serves a project
 * site from /<repository>/, which astro.config.mjs takes from KEPT_DOCS_BASE; Markdown links get
 * it from the config's baseLinks plugin, links in components get it here.
 */
const base = import.meta.env.BASE_URL.replace(/\/+$/, '');

export function withBase(href: string): string {
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith(`${base}/`)
    ? `${base}${href}`
    : href;
}
