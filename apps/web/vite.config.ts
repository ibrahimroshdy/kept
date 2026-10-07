import { fileURLToPath } from 'node:url';
import { getConfig } from '@lingui/conf';
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin';
import babel from '@rolldown/plugin-babel';
import { serwist } from '@serwist/vite';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Explicit, because the root `vitest` run starts from the repo root, where Lingui would look.
// The macro plugin gets the resolved config too: the preset doesn't pass it on.
const configPath = fileURLToPath(new URL('./lingui.config.ts', import.meta.url));
const linguiConfig = getConfig({ configPath });

/**
 * Chunks the service worker caches when first used instead of precaching (sw.ts, plan T23):
 * - lucide-react/dynamic's one chunk per icon (about 1,800), and its name → import map
 *   (DynamicIcon, about 290 KB), which only custom type icons and the icon picker load: assets/icons/;
 * - the Lingui catalogues, one per language, of which a person uses one: assets/locales/;
 * - the thing page's step-4 sections (warranties, claims, value, loans, schedules; T20), the
 *   notification centre and Me → Notifications (T24, T25), incidents, reports and exchange rates
 *   (T26), Schedules, Lending, Paperwork, Expiring and a brand's logo (T29), and settings, admin,
 *   AI settings and usage, the import, Activity and Trash, which all read the server, so they're
 *   no use offline before their first load; and the hints' driver.js, which a hint can do
 *   without: assets/household/. The folder and the `kept-household` cache keep their step-4 name.
 * scripts/check-bundle.mjs fails the build if either reaches the precache.
 */
const LUCIDE_ICON = '/lucide-react/dist/esm/icons/';
const LUCIDE_DYNAMIC = '/lucide-react/dist/esm/DynamicIcon.mjs';
const HOUSEHOLD_SECTIONS = [
  // The assistant's sheet and docked panel (step 6, T19): loaded when first opened
  // (assistant/host.tsx); it needs a connection anyway.
  '/src/assistant/surface.tsx',
  '/src/components/things/household-sections.tsx',
  '/src/components/incidents/screens.household.tsx',
  // A brand's logo and its Add · Replace · Remove (T29).
  '/src/components/registries/brand-logo.household.tsx',
  // A things list's Export view and Print (step 7, T16): both need the server.
  '/src/components/filters/list-export.household.tsx',
  // Consumables' Adjust and a thing's "Keep at least" (step 7, T23), and converting a type's
  // field (T24): each reads and writes the server.
  '/src/components/consumables/stock.household.tsx',
  '/src/components/registries/convert-field-sheet.household.tsx',
  // A vehicle's tabs (step 5, T18): costs, the meter's series and proofs, fills and documents all
  // read the server. Its charts load later still, with the tab that draws them (visx, D133).
  '/src/components/vehicles/vehicle-sections.tsx',
  '/src/components/charts/bars.tsx',
  '/src/components/charts/series.tsx',
  '/src/components/fuel/fuel-trends.tsx',
];
/** Route components (TanStack's split chunks) that read the server and load on demand. */
const HOUSEHOLD_ROUTES = [
  '/src/routes/_app/notifications.tsx?tsr-split=component',
  '/src/routes/_app/settings.me.notifications.tsx?tsr-split=component',
  '/src/routes/_app/incidents.tsx?tsr-split=component',
  '/src/routes/_app/incidents.$id.tsx?tsr-split=component',
  '/src/routes/_app/reports.$kind.tsx?tsr-split=component',
  '/src/routes/_app/settings.account.exchange-rates.tsx?tsr-split=component',
  // Step 4's lists (T29): Schedules, Lending, Paperwork and Expiring read the server only.
  '/src/routes/_app/schedules.tsx?tsr-split=component',
  '/src/routes/_app/lending.tsx?tsr-split=component',
  '/src/routes/_app/paperwork.tsx?tsr-split=component',
  '/src/routes/_app/expiring.tsx?tsr-split=component',
  // Step 5 (T3, T17): the Vehicles list reads the server; it isn't in the phone's snapshot.
  '/src/routes/_app/vehicles.tsx?tsr-split=component',
  // Step 7 (T3): Export and Consumables need a connection. The old-label pages (/a, /item,
  // /location) stay precached: a label opens offline.
  '/src/routes/_app/settings.export.tsx?tsr-split=component',
  '/src/routes/_app/consumables.tsx?tsr-split=component',
  // Step 6 (T3): the assistant, Connections and a location's webhooks read the server; none is
  // any use offline. OAuth consent stays precached, like the sign-in pages it follows (T22).
  '/src/routes/_app/assistant.index.tsx?tsr-split=component',
  '/src/routes/_app/assistant.$threadId.tsx?tsr-split=component',
  '/src/routes/_app/settings.connections.tsx?tsr-split=component',
  '/src/routes/_app/settings.location.$id.webhooks.tsx?tsr-split=component',
  // Settings, admin, imports and history need a connection (screens §4), so they come on demand
  // too, reclaiming precache for steps 5–7 (components/on-demand-route-error.tsx). Settings → Me,
  // Diagnostics and Help stay precached: they're this device's own.
  ...[
    'admin',
    'admin.index',
    'admin.admins',
    'admin.ai',
    'admin.ai.usage',
    'admin.alerts',
    'admin.backups',
    'admin.currencies',
    'admin.jobs',
    'admin.settings',
    'admin.status',
    'admin.users',
    'settings.account',
    'settings.account.index',
    'settings.account.brands',
    'settings.account.people',
    'settings.account.place-kinds',
    'settings.account.tags',
    'settings.account.templates',
    'settings.account.types',
    'settings.account.vendors',
    'settings.ai',
    'settings.ai.usage',
    'settings.me.ai',
    // Step 8 (T3): This device; the lock screen itself is in the shell, precached (T23).
    'settings.device',
    'settings.import',
    'settings.locations',
    'settings.location.$id.general',
    'settings.location.$id.invite',
    'settings.location.$id.members',
    'settings.location.$id.track',
    'settings.two-factor',
    'activity',
    'trash',
  ].map((r) => `/src/routes/_app/${r}.tsx?tsr-split=component`),
];
/**
 * Routes that keep their error screen in the route's definition, precached, so a page that can't
 * load offline still says "Needs a connection"; only the page itself is split out (TanStack's
 * default gives the error screen a precached chunk of its own). A layout's error screen covers its
 * children, which have none of their own (/admin, /settings/account, /settings/ai).
 */
const COMPONENT_ONLY_ROUTES = new Set<string>([
  '/_app/assistant/',
  '/_app/assistant/$threadId',
  '/_app/settings/connections',
  '/_app/settings/location/$id/webhooks',
  '/_app/admin',
  '/_app/settings/account',
  '/_app/settings/ai',
  '/_app/settings/me/ai',
  '/_app/settings/import',
  '/_app/settings/locations',
  '/_app/settings/location/$id/general',
  '/_app/settings/location/$id/invite',
  '/_app/settings/location/$id/members',
  '/_app/settings/location/$id/track',
  '/_app/settings/two-factor',
  '/_app/activity',
  '/_app/trash',
  '/_app/vehicles',
]);
/**
 * On-demand chunks named by their entry module: driver.js behind the hints and the tour
 * (components/hints/driver-kit.ts; a failed import just skips the hint), and the import's CSV
 * parser. The import's worker goes to assets/household/ too (`worker` below).
 */
const ON_DEMAND_ENTRIES = [
  '/src/components/hints/driver-kit.ts',
  '/papaparse/papaparse.min.js',
  '/src/components/import/parse-config.ts',
];
/**
 * Shared chunks only the chunks above import (T29): a chunk made of nothing but these modules is
 * on demand too. scripts/check-bundle.mjs fails the build if a precached chunk imports one.
 */
const HOUSEHOLD_SHARED = [
  '/src/components/services/',
  '/src/components/agenda/agenda-row.tsx',
  '/src/components/schedules/complete-sheet.tsx',
  '/src/components/schedules/labels.tsx',
  '/src/components/schedules/list-query.ts',
  '/src/components/schedules/schedule-row.tsx',
  '/src/components/schedules/schedule-sheet.tsx',
  '/src/components/schedules/snooze-sheet.tsx',
  // AI settings and usage (Settings, Me and admin); ai-line and call-detail stay precached.
  '/src/components/ai/advanced.tsx',
  '/src/components/ai/call-list.tsx',
  '/src/components/ai/cap-suggest.tsx',
  '/src/components/ai/data-use-note.tsx',
  '/src/components/ai/disclosure.tsx',
  '/src/components/ai/key-scope.tsx',
  '/src/components/ai/model-picker.tsx',
  '/src/components/ai/paste-key.tsx',
  '/src/components/ai/prices.tsx',
  '/src/components/ai/recommended.tsx',
  '/src/components/ai/settings-page.tsx',
  '/src/components/ai/usage-charts.tsx',
  '/src/components/ai/usage-page.tsx',
  '/src/components/ai/usage-totals.tsx',
  '/src/components/ai/what-uses-ai.tsx',
  '/src/components/location-settings.tsx',
  // The assistant (step 6, T19, T20), shared by its sheet and its two pages. Not dictation.ts,
  // which Capture's precached name field uses too, nor store/open/button/host (entry chunk).
  ...[
    'answer.tsx',
    'composer.tsx',
    'confirm-card.tsx',
    'confirm-rows.ts',
    'context-chip.tsx',
    'context.ts',
    'conversation.tsx',
    'icons.tsx',
    'link-only-markdown.tsx',
    'panel.tsx',
    'sheet.tsx',
    'thread.tsx',
    'threads-list.tsx',
    'use-turn.ts',
  ].map((f) => `/src/assistant/${f}`),
  '/src/api/assistant/queries.ts',
  // Shared by step 4's thing sections and a vehicle's tabs (step 5, T18), which now load as two
  // on-demand chunks: the schedules section, gated money, and matchSchedules for Log a service.
  '/src/components/things/schedules-section.tsx',
  '/src/components/money/gated.tsx',
  '/packages/shared/src/services.ts',
  // visx and the d3 it brings, shared by the vehicle and fuel charts (step 5).
  '/src/components/charts/kit.tsx',
  '/node_modules/@visx/',
  '/node_modules/d3-',
  '/node_modules/internmap/',
  '/node_modules/classnames/',
  '/node_modules/react-use-measure/',
  // @visx/text's CSS calc() reducer.
  '/node_modules/balanced-match/',
  '/node_modules/reduce-function-call/',
  '/node_modules/math-expression-evaluator/',
  '/node_modules/reduce-css-calc/',
];
const chunkFileName = (chunk: { facadeModuleId: string | null; moduleIds: string[] }) => {
  if (chunk.facadeModuleId?.endsWith('/messages.po')) return 'assets/locales/[name]-[hash].js';
  if (
    HOUSEHOLD_SECTIONS.some((m) => chunk.facadeModuleId?.endsWith(m)) ||
    HOUSEHOLD_ROUTES.some((r) => chunk.facadeModuleId?.endsWith(r)) ||
    ON_DEMAND_ENTRIES.some((m) => chunk.facadeModuleId?.endsWith(m)) ||
    (!chunk.facadeModuleId &&
      chunk.moduleIds.length > 0 &&
      chunk.moduleIds.every((id) => HOUSEHOLD_SHARED.some((m) => id.includes(m))))
  )
    return 'assets/household/[name]-[hash].js';
  if (
    chunk.facadeModuleId?.includes(LUCIDE_ICON) ||
    chunk.moduleIds.some((id) => id.endsWith(LUCIDE_DYNAMIC))
  )
    return 'assets/icons/[name]-[hash].js';
  return 'assets/[name]-[hash].js';
};

// The router plugin must run before react() so it can split route files (TanStack docs).
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      quoteStyle: 'single',
      codeSplittingOptions: {
        splitBehavior: ({ routeId }) =>
          COMPONENT_ONLY_ROUTES.has(routeId) ? [['component']] : undefined,
      },
    }),
    react(),
    lingui({ configPath }),
    babel({ presets: [linguiTransformerBabelPreset({ linguiConfig }, { configPath })] }),
    tailwindcss(),
    // The service worker (plan T23; spike docs/spikes/2026-09-26-step3-serwist.md): src/sw.ts is
    // built to dist/sw.js with the precache manifest injected. The precache is the shell, the
    // fonts Kept renders (Latin and Arabic), the icons and the scanner's wasm, so capture and scan
    // work offline (D101). Never /api or /f: authenticated responses stay out of the Cache API
    // (D181, sw.ts). scripts/check-bundle.mjs holds its size budget.
    serwist({
      swSrc: 'src/sw.ts',
      swDest: 'sw.js',
      globDirectory: 'dist',
      injectionPoint: 'self.__SW_MANIFEST',
      rollupFormat: 'iife',
      // The default is only '**/*.{js,css,html}', which leaves out the fonts and the wasm.
      globPatterns: ['**/*.{js,css,html,woff2,wasm,svg,png,webmanifest}'],
      globIgnores: [
        // Cached when first used (sw.ts): lucide's icons and its DynamicIcon map, and the
        // catalogues, of which the shell needs only the one in use.
        'assets/icons/**',
        'assets/locales/**',
        'assets/household/**',
        'sw.js',
        // Font subsets Kept never renders: its languages are Latin-script and Arabic (D204).
        'assets/ibm-plex-*-{cyrillic,cyrillic-ext,greek,vietnamese}-*.woff2',
      ],
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // No data: URIs: the server's CSP is `default-src 'self'` (http/app.ts), which blocks inlined
  // fonts and images. Every asset ships as its own fingerprinted file under /assets/.
  build: {
    assetsInlineLimit: 0,
    // A chunk loaded on demand from assets/household/ isn't preloaded with its dependencies: their
    // names would sit in the precached chunk that imports it (about 5 KB for T26's screens, which
    // the precache budget can't spare), and the chunk is fetched once, then cached (sw.ts). Its
    // CSS is kept: the preload is the only thing that loads it (driver.js's, for the hints).
    modulePreload: {
      resolveDependencies: (filename, deps, { hostType }) =>
        hostType === 'js' && filename.startsWith('assets/household/')
          ? deps.filter((d) => d.endsWith('.css'))
          : deps,
    },
    rolldownOptions: {
      output: {
        chunkFileNames: chunkFileName,
        // driver.js's CSS goes with its chunk (ON_DEMAND_ENTRIES).
        assetFileNames: (asset) =>
          asset.names.some((n) => n.startsWith('driver-kit'))
            ? 'assets/household/[name]-[hash][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  // The import's CSV worker (components/import/parse.ts) is on demand like the import itself.
  worker: {
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/household/[name]-[hash].js',
        chunkFileNames: 'assets/household/[name]-[hash].js',
      },
    },
  },
  // @kept/shared reads process.env.KEPT_VERSION for the server; the browser has no `process`, so
  // the build inlines it. The image's build sets it to the release's version (Dockerfile, D148),
  // so the client and its sync clientVersion say the real one; unset, KEPT_VERSION falls back to
  // 0.0.0-dev as on the server.
  define: {
    'process.env.KEPT_VERSION': process.env.KEPT_VERSION
      ? JSON.stringify(process.env.KEPT_VERSION)
      : 'undefined',
  },
});
