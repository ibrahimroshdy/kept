/**
 * What the service worker (src/sw.ts) routes where, as plain functions so they can be tested
 * without a worker. Nothing here touches `self`.
 */

/**
 * Authenticated paths: the API and file downloads. They always go to the network and are never
 * put in the Cache API (D181), so a signed-out phone keeps nothing of them.
 */
export function isAuthenticatedPath(pathname: string): boolean {
  return /^\/(?:api|f)(?:\/|$)/.test(pathname);
}

/**
 * lucide's per-icon chunks and its DynamicIcon map (vite.config.ts moves them to assets/icons/).
 * They are public and fingerprinted, so the worker keeps each one once it has been seen instead
 * of precaching 1,800 icons and a 290 KB map.
 */
export function isIconChunk(pathname: string): boolean {
  return pathname.startsWith('/assets/icons/');
}

/**
 * The Lingui catalogues (assets/locales/, one per language). A person uses one, so it is kept
 * when first loaded rather than precaching all five.
 */
export function isLocaleChunk(pathname: string): boolean {
  return pathname.startsWith('/assets/locales/');
}

/**
 * The on-demand chunks (assets/household/, vite.config.ts): step 4's sections and screens,
 * settings, admin, the import and the rest that read the server. They are kept when first used
 * rather than precached (the precache budget).
 */
export function isHouseholdChunk(pathname: string): boolean {
  return pathname.startsWith('/assets/household/');
}

/** Chunks the worker caches on first use rather than at install. */
export function isRuntimeCachedChunk(pathname: string): boolean {
  return isIconChunk(pathname) || isLocaleChunk(pathname) || isHouseholdChunk(pathname);
}

/** Navigations the precached shell must never answer: the API, files, the share target, and the
 * image's third-party notices (D151), a server file the version footer opens. */
export const NAVIGATE_FALLBACK_DENYLIST = [/^\/api\//, /^\/f\//, /^\/share/, /^\/notices\.txt$/];
