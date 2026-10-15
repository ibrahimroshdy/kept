/**
 * Try Kept (D246): where the web app's demo build lives on the docs site. The page that opens it
 * is /try/kept/ (src/content/docs/try/kept.mdx); the app itself is a static copy under
 * /try/kept/app/ (scripts/try-app.ts writes it into public/, so Astro copies it as it is). The
 * app's own `docsUrl()` (apps/web/src/try/flag.ts) walks back from this path to the site's root,
 * so the two must change together.
 */
export const TRY_APP_PATH = 'try/kept/app/';

/** The app's base path (Vite's `base`) under the docs site's base: `/` gives `/try/kept/app/`. */
export function tryAppBase(docsBase: string): string {
  const root = `/${docsBase.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  return `${root}${TRY_APP_PATH}`;
}

/**
 * The link that opens it: the page's language goes along (`?lang=ar`); the docs theme is added
 * when it is clicked (TryKept.astro), so the app opens in the theme the page is in.
 */
export function tryAppHref(docsBase: string, lang: 'en' | 'ar'): string {
  return `${tryAppBase(docsBase)}?lang=${lang}`;
}
