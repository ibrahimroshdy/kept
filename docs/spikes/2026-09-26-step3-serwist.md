# Spike V17: Serwist with Vite 8 (rolldown)

Date: 2026-09-26. Step-3 plan, Task 0. Result: **proven on the plugin path; the
`@serwist/build` fallback was not needed.** Two changes to the plan's config are required
(`globPatterns`, and keeping lucide's per-icon chunks out of the precache), and the plan's
3 MB precache budget does not hold with the scanner's wasm in it.

Code: `docs/spikes/code/step3/web/` (`vite.config.ts`, `src/sw.ts`, `src/spike-register.ts`,
`csp-server.mjs`, `spike-e2e/serwist.spec.ts`), reproduced by `docs/spikes/code/step3/apply.sh`.
Nothing was merged into `apps/`.

## Versions (checked with `npm view` on 2026-09-26)

| Package | Version | Licence | Notes |
|---|---|---|---|
| `serwist` | 9.5.12 | MIT | |
| `@serwist/vite` | 9.5.12 | MIT | peer deps `vite >=5`, `rollup >=4`, `typescript >=5`. pnpm installed it on Vite 8.3.1 (rolldown 1.2.11) with no `rollup` package and no peer error |
| `@serwist/window` | 9.5.12 | MIT | |
| `@serwist/build` | 9.5.12 | MIT | comes with `@serwist/vite`; only needed directly for the fallback |

## What was proven

Built `apps/web` with the plugin, then ran Playwright 1.63.0 (its Chromium) against the build. All
of these passed:

- **`dist/sw.js` exists.** It is an IIFE with the precache manifest inlined. The manifest lists:
  - the hashed JS and CSS;
  - the `.woff2` fonts;
  - `assets/zxing_reader-<hash>.wasm`;
  - `index.html` and the icons.

  The manifest has 176 entries, and the plugin reports 3,409.68 KiB.
- **Hashed files carry `revision: null`.** `dontCacheBustURLsMatching` defaults to `^assets/`.
  `index.html` gets a content revision.
- **It installs through `vite preview`**, and under a static server that sends Kept's real CSP
  directives (`default-src 'self'; script-src 'self' <index.html hash>; frame-ancestors 'none'`).
  `clientsClaim: true` controls the first load without a reload.
- **The shell works offline.** With `context.setOffline(true)`:
  - a reload renders the app;
  - a deep link (`/things/some-id`) gets the precached `index.html` through `navigateFallback`;
  - `fetch('/api/ping')` fails, because `NetworkOnly` has no cache to fall back on.
- **No `/api/` or `/f/` URL ever enters the Cache API** (D181). This was checked after an online
  `/api/ping`.
- **The D148 update flow works with `@serwist/window`.**
  1. A changed `sw.js` fires `waiting`.
  2. The new worker stays waiting.
  3. `messageSkipWaiting()` hands over, and `controlling` fires.
- **`src/sw.ts` typechecks inside the existing DOM project** (TypeScript 7.0.2, `tsc --noEmit`
  in `apps/web`, exit 0). It needs `/// <reference lib="webworker" />`,
  `declare const self: ServiceWorkerGlobalScope`, and a `WorkerGlobalScope` augmentation for
  `__SW_MANIFEST`. No separate tsconfig is needed.

## Exact config that worked (for T23)

Option names were read from `@serwist/vite` `dist/index.d.mts` and `@serwist/build`
`dist/index.d.mts`. The plan's five names are all correct:

```ts
serwist({
  swSrc: 'src/sw.ts',
  swDest: 'sw.js',
  globDirectory: 'dist',
  injectionPoint: 'self.__SW_MANIFEST',
  rollupFormat: 'iife',
  // REQUIRED: the default is ['**/*.{js,css,html}'], which leaves out the fonts and the wasm.
  globPatterns: ['**/*.{js,css,html,woff2,wasm,svg,png,webmanifest}'],
  globIgnores: [
    'assets/icons/**',                                                  // see "lucide" below
    'sw.js',
    'assets/ibm-plex-*-{cyrillic,cyrillic-ext,greek,vietnamese}-*.woff2', // English and Arabic only
  ],
}),
```

The plan's config also needs **one addition to `build`**:

```ts
build: {
  assetsInlineLimit: 0,
  rolldownOptions: {                // Vite 8's name; `rollupOptions` is a deprecated alias
    output: {
      chunkFileNames: (chunk) =>
        chunk.facadeModuleId?.includes('/lucide-react/dist/esm/icons/')
          ? 'assets/icons/[name]-[hash].js'
          : 'assets/[name]-[hash].js',
    },
  },
},
```

**The lucide chunks.** `components/type-icon-dynamic.tsx` imports `lucide-react/dynamic`, and
the build emits **1,812 per-icon chunks**.
- Precaching them would add about 1,800 requests to the install. The whole `dist` was 9.1 MB of
  JS before this change.
- Moving them to `assets/icons/` and ignoring them keeps them out of the precache.
- `sw.ts` then keeps each icon once it has been seen, with a runtime `CacheFirst` (public,
  fingerprinted, not authenticated, so D181 allows it):

```ts
{ matcher: ({url, sameOrigin}) => sameOrigin && url.pathname.startsWith('/assets/icons/'),
  handler: new CacheFirst({cacheName: 'kept-icons', plugins: [new ExpirationPlugin({maxEntries: 400})]}) }
```

**`sw.ts`.** It follows the plan's sketch, with these corrections:
- **Use `precacheOptions` for the SPA fallback**:
  `precacheOptions: {cleanupOutdatedCaches: true, navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//, /^\/f\//, /^\/share/]}`.
  These are the `PrecacheOptions` names in `serwist` `dist/chunks/types-*.d.ts`. A hand-built
  `NavigationRoute` isn't needed.
- **Drop the manual `SKIP_WAITING` listener.** With `skipWaiting: false`, the `Serwist`
  constructor already adds `message` → `if (event.data.type === 'SKIP_WAITING') self.skipWaiting()`
  (`serwist` `dist/index.mjs`). `@serwist/window`'s `messageSkipWaiting()` sends exactly that. A
  second listener is harmless, but it's dead code.
- **Scope the `NetworkOnly` matcher to `sameOrigin`**, as in the spike.

**Registration.** `new Serwist('/sw.js', {scope: '/', type: 'classic'})` from `@serwist/window`.
The events are `waiting` (with `wasWaitingBeforeRegister`) and `controlling`. The methods are
`register()` and `messageSkipWaiting()`.

## The precache budget (a change to T23's test)

The build reports 176 entries and 3,409.68 KiB (`precacheBytes` 3,491,517). Measured:

| Part | Size |
|---|---|
| `zxing_reader.wasm` | 1,093,289 B (455,940 B gzip -9) |
| JS (143 chunks) | about 1.8 MB |
| `woff2`, 21 files after dropping 4 subsets | about 410 KB (it was 613 KB for 45 files) |
| CSS, HTML, icons | the rest |

The spike build also has the scanner and hints pages as extra inputs. That is also why the entry
chunk is `main-*.js` here: T23's build has one input, so it stays `index-*.js`, and
`scripts/check-bundle.mjs` keeps working.

**Proposal:** T23's budget test becomes **"precache under 3 MB excluding `zxing_reader*.wasm`"**,
which measured about 2.4 MB (2,398,228 B), with the wasm checked separately at under 1.2 MB. A plain
"under 3 MB" fails today. The wasm has to be precached, because iOS has no native
`BarcodeDetector` and scanning must work offline.

## Fallback

Not taken. `@serwist/vite` runs a second `vite build` in lib mode (`formats: [rollupFormat]`)
from its `closeBundle` hook, and that works on Vite 8.3.1. It passes `rollupOptions`, which
Vite 8 still accepts as a deprecated alias. No warning was printed. If a later Vite drops the
alias, the fallback in the plan (`scripts/build-sw.mjs` + `@serwist/build` `injectManifest`)
still applies.

**Not covered:**
- `vite dev` with the plugin (`devOptions`);
- the real Fastify server. The CSP directives were reproduced in `csp-server.mjs` instead.
