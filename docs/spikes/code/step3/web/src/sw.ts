/// <reference lib="webworker" />
// SPIKE (step 3, T0, V17). Throwaway service worker; T23 writes the real one.
// Names from serwist 9.5.12 dist/index.d.mts: Serwist, NetworkOnly, CacheFirst, ExpirationPlugin,
// SerwistGlobalConfig, PrecacheEntry; precacheOptions.navigateFallback(+Denylist) from
// chunks/types-*.d.ts PrecacheOptions.
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkOnly,
  type PrecacheEntry,
  Serwist,
  type SerwistGlobalConfig,
} from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    cleanupOutdatedCaches: true,
    // SPA navigations offline get the precached shell; never for the API, files or share POSTs.
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api\//, /^\/f\//, /^\/share/],
  },
  // D148: a new worker waits; the page decides when. Serwist itself listens for
  // {type: 'SKIP_WAITING'} when skipWaiting is false (serwist dist/index.mjs), so no extra
  // message listener is needed.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      // D181: authenticated responses never go into the Cache API.
      matcher: ({ url, sameOrigin }) =>
        sameOrigin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/f/')),
      handler: new NetworkOnly(),
    },
    {
      // lucide per-icon chunks: public, fingerprinted, not precached. Kept once seen.
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/icons/'),
      handler: new CacheFirst({
        cacheName: 'kept-icons',
        plugins: [new ExpirationPlugin({ maxEntries: 400 })],
      }),
    },
  ],
});

serwist.addEventListeners();
