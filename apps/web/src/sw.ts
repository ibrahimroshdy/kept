/// <reference lib="webworker" />
/**
 * Kept's service worker (plan T23; D101, D148, D181; spike docs/spikes/2026-09-26-step3-serwist.md).
 * Built by @serwist/vite (vite.config.ts) to dist/sw.js, with the precache manifest injected at
 * `self.__SW_MANIFEST`.
 *
 * - **Precache:** the shell (index.html, JS, CSS), the fonts Kept renders, the icons and the
 *   scanner's wasm, so the app opens, captures and scans offline. Old precaches are cleaned up.
 * - **Cached on first use** (CacheFirst): lucide's icon chunks and DynamicIcon map
 *   (`kept-icons`), the catalogue of the language in use (`kept-locales`), and the chunks that
 *   need a connection anyway: step 4's sections and screens, settings, admin, the import
 *   (`kept-household`, vite.config.ts). The page fetches
 *   the ones it already loaded again once this worker controls it (register.ts), so the first
 *   visit's language works offline too.
 * - **Offline navigations** get the precached index.html, never for /api, /f or /share.
 * - **Authenticated responses are never cached** (D181): /api and /f are NetworkOnly.
 * - **Updates wait** (D148): `skipWaiting: false`. The page sends `{type: 'SKIP_WAITING'}` only
 *   when the person taps Reload and nothing is uploading (pwa/update-prompt.tsx); Serwist listens
 *   for that message itself when skipWaiting is off. `clientsClaim` takes the first visit.
 * - **Share into Kept** (D140): the manifest's POST /share is read here and handed to the page
 *   (pwa/share-target.ts).
 * - **Push** (D30, T24): a push shows the server's notification; a tap focuses an open Kept
 *   window and takes it to the notification's URL, or opens one (pwa/push-worker.ts).
 */
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkOnly,
  type PrecacheEntry,
  type RouteHandlerCallbackOptions,
  Serwist,
  type SerwistGlobalConfig,
} from 'serwist';
import type { SharedInto } from './offline/store';
import { onNotificationClick, onPush } from './pwa/push-worker';
import {
  SHARE_ACTION,
  SHARE_HOLD_MS,
  shareFromForm,
  TAKE_SHARE,
  type TakeShareMessage,
  type TakeShareReply,
} from './pwa/share-target';
import {
  isAuthenticatedPath,
  isHouseholdChunk,
  isIconChunk,
  isLocaleChunk,
  NAVIGATE_FALLBACK_DENYLIST,
} from './pwa/sw-routes';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

/** Shares waiting for the page to claim them, with the resolver that ends their hold. */
const held = new Map<string, { share: SharedInto; release: () => void }>();

async function receiveShare({ request, event }: RouteHandlerCallbackOptions): Promise<Response> {
  const to = (path: string) => Response.redirect(new URL(path, self.location.origin).href, 303);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return to('/capture?share=failed');
  }
  const share = shareFromForm(form, crypto.randomUUID(), new Date().toISOString());
  if (share.files.length === 0) return to('/capture?share=empty');
  // Keep the worker alive until the page claims the share, or the hold runs out.
  event.waitUntil(
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        held.delete(share.id);
        resolve();
      }, SHARE_HOLD_MS);
      held.set(share.id, {
        share,
        release: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    }),
  );
  return to(`/capture?shared=${encodeURIComponent(share.id)}`);
}

self.addEventListener('message', (event) => {
  const data = event.data as Partial<TakeShareMessage> | undefined;
  if (data?.type !== TAKE_SHARE || typeof data.id !== 'string') return;
  const entry = held.get(data.id);
  held.delete(data.id);
  const reply: TakeShareReply = { share: entry?.share ?? null };
  event.ports[0]?.postMessage(reply);
  entry?.release();
});

self.addEventListener('push', (event) => onPush(self, event));
self.addEventListener('notificationclick', (event) => onNotificationClick(self, event));

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    cleanupOutdatedCaches: true,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
  },
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && isAuthenticatedPath(url.pathname),
      handler: new NetworkOnly(),
    },
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname === SHARE_ACTION,
      method: 'POST',
      handler: receiveShare,
    },
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && isIconChunk(url.pathname),
      handler: new CacheFirst({
        cacheName: 'kept-icons',
        plugins: [new ExpirationPlugin({ maxEntries: 400 })],
      }),
    },
    {
      // The on-demand chunks (assets/household/, vite.config.ts), once opened; the old build's go
      // by expiry. About 65 files a build since settings and admin moved there: room for all of
      // them and a build's worth of stale ones.
      matcher: ({ url, sameOrigin }) => sameOrigin && isHouseholdChunk(url.pathname),
      handler: new CacheFirst({
        cacheName: 'kept-household',
        plugins: [new ExpirationPlugin({ maxEntries: 160 })],
      }),
    },
    {
      // The catalogue in use (and one or two after a language switch or an update).
      matcher: ({ url, sameOrigin }) => sameOrigin && isLocaleChunk(url.pathname),
      handler: new CacheFirst({
        cacheName: 'kept-locales',
        plugins: [new ExpirationPlugin({ maxEntries: 3 })],
      }),
    },
  ],
});

serwist.addEventListeners();
