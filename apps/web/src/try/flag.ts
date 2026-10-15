/**
 * Try Kept (D246): the demo build published on the docs site, `/try/kept/app/` on
 * keptinventory.info (`pnpm --filter @kept/web build:try`, apps/docs/scripts/try-app.mjs). It is
 * the demo build (src/demo.ts) with the owner scenario always on, served from a sub-path of a
 * static host, so:
 *
 * - the router uses hash history (`/try/kept/app/#/things`): the host has one index.html and
 *   answers 404 for any other path, so a reload or a shared link must never ask it for one;
 * - no service worker, no web app manifest, no install prompt, no push: a worker registered
 *   under the docs site's origin could take over its pages;
 * - camera, microphone, location, passkeys and notifications are never asked for: the screens
 *   that use them say they are off here (try/off.tsx);
 * - a banner says it is a sample household in the browser, with Reset and Install Kept.
 *
 * A compile-time constant: false in every other build, where each branch it guards is dropped.
 */
export const TRY = import.meta.env.VITE_KEPT_TRY === '1';

/** The app's own path on the docs site, `/try/kept/app/` (Vite's `base`, from vite.config.ts). */
export const appBase = (): string => import.meta.env.BASE_URL;

/**
 * A docs site page (`/install/compose/`) from the app: the docs site's root is three levels up
 * from the app's base (`<docs base>try/kept/app/`), and an Arabic page lives under `/ar/`.
 */
export function docsUrl(path: string, locale: string, base: string = appBase()): string {
  const root = base.replace(/try\/kept\/app\/$/, '');
  const page = path.replace(/^\/+/, '');
  return `${root}${locale === 'ar' ? 'ar/' : ''}${page}`;
}
