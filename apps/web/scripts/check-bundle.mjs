#!/usr/bin/env node
// The entry-bundle weight check (D80, lessons L88). Runs after `vite build`: finds the entry
// chunk that dist/index.html loads, gzips it, and fails when it is more than BUDGET bytes over
// the recorded baseline. Everything else is code-split per route, so the entry chunk is what
// every first visit pays for; an icon library imported by accident shows up here first.
//
// It also checks the service worker's precache (plan T23; spike docs/spikes/2026-09-26-step3-serwist.md):
// everything a phone downloads on install, under PRECACHE_BUDGET without the scanner's wasm, the
// wasm on its own under WASM_BUDGET, index.html precached at its current content, and nothing
// authenticated, no icon chunk (per-icon or the DynamicIcon map) and no Lingui catalogue in it:
// those are cached on first use (vite.config.ts, sw.ts).
//
// The on-demand rule for new screens: the precache holds only what the offline promise needs
// (screens §4: the shell, Home, browsing places and things, capture, the inbox, scan and old
// labels, search, the offline store and sync). A screen that needs a connection anyway (settings,
// admin, imports, exports, reports, the assistant, anything reading only the server) loads on
// demand: add its route's `?tsr-split=component` chunk to HOUSEHOLD_ROUTES in vite.config.ts (and
// any chunk only it imports to HOUSEHOLD_SHARED), give the route an errorComponent that says
// "Needs a connection" offline (components/on-demand-route-error.tsx, or a layout's, which covers
// its children), and list its id in COMPONENT_ONLY_ROUTES so that error screen stays precached
// without a chunk of its own. Don't raise PRECACHE_BUDGET to fit a server-only screen.
//
// Usage: node scripts/check-bundle.mjs                   (check; exit 1 when over budget)
//        node scripts/check-bundle.mjs --update-baseline (record the current size on purpose)
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const web = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = join(web, 'bundle-baseline.json');
/** 25 KB gzip over the baseline (plan task 3). */
export const BUDGET = 25 * 1024;
/**
 * The precache, excluding the scanner's wasm: "3 MB" in the unit Serwist's build log prints
 * (KiB), so the figure after "precache entries" is what this compares. T0 measured about 2.4 MB.
 */
export const PRECACHE_BUDGET = 3 * 1024 * 1024;
/** The scanner's wasm, precached so scanning works offline on iOS (D101); 1.09 MB in T0. */
export const WASM_BUDGET = 1_200_000;
const WASM = /(?:^|\/)zxing_reader[^/]*\.wasm$/;

/** The entry script's path relative to dist/, read from the built index.html. */
export function entryOf(indexHtml) {
  const m = /<script[^>]*type="module"[^>]*src="\/([^"]+\.js)"/.exec(indexHtml);
  if (!m?.[1]) throw new Error('no module entry script in dist/index.html');
  return m[1];
}

export function measure(dist) {
  const entry = entryOf(readFileSync(join(dist, 'index.html'), 'utf8'));
  const bytes = readFileSync(join(dist, entry));
  return { entry, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

/** The precache manifest Serwist injected into dist/sw.js: `[{url, revision}]`. */
export function precacheEntries(swJs) {
  const entries = [];
  for (const m of swJs.matchAll(
    /\{url:[`"']([^`"']+)[`"'],revision:(?:[`"']([^`"']*)[`"']|null)\}/g,
  ))
    entries.push({ url: m[1], revision: m[2] ?? null });
  if (entries.length === 0) throw new Error('no precache manifest in dist/sw.js');
  return entries;
}

/** A static `import … from "./household/…"` (or `import "./household/…"`), not `import(…)`. */
const STATIC_HOUSEHOLD =
  /\bimport\s*(?:[^;()'"`]*?\bfrom\s*)?["'`][^"'`]*\bhousehold\/[^"'`]*["'`]/;

/** Sizes and rule checks for the precache; `problems` is empty when it passes. */
export function checkPrecache(dist) {
  const entries = precacheEntries(readFileSync(join(dist, 'sw.js'), 'utf8'));
  let bytes = 0;
  let wasm = 0;
  const problems = [];
  for (const e of entries) {
    const size = statSync(join(dist, e.url)).size;
    if (WASM.test(e.url)) wasm += size;
    else bytes += size;
    if (/^(?:api|f)\//.test(e.url)) problems.push(`authenticated path precached: ${e.url}`);
    if (e.url.startsWith('assets/icons/') || /(?:^|\/)DynamicIcon-[^/]*\.js$/.test(e.url))
      problems.push(`icon chunk precached (sw.ts caches these on first use): ${e.url}`);
    if (e.url.startsWith('assets/locales/') || /(?:^|\/)messages-[^/]*\.js$/.test(e.url))
      problems.push(`catalogue precached (sw.ts caches the one in use): ${e.url}`);
    // A precached chunk may load an on-demand one (`import(…)`), never import it statically:
    // offline before its first use, the precached chunk itself would fail to load.
    if (e.url.endsWith('.js') && STATIC_HOUSEHOLD.test(readFileSync(join(dist, e.url), 'utf8')))
      problems.push(`precached chunk imports an on-demand household chunk: ${e.url}`);
  }
  const index = entries.find((e) => e.url === 'index.html');
  const md5 = createHash('md5')
    .update(readFileSync(join(dist, 'index.html')))
    .digest('hex');
  if (!index) problems.push('index.html is not precached');
  else if (index.revision !== md5)
    problems.push(`index.html precached at revision ${index.revision}, but the file is ${md5}`);
  if (bytes > PRECACHE_BUDGET)
    problems.push(`precache ${bytes} B is over the ${PRECACHE_BUDGET} B budget (wasm excluded)`);
  if (wasm > WASM_BUDGET) problems.push(`scanner wasm ${wasm} B is over ${WASM_BUDGET} B`);
  return { entries: entries.length, bytes, wasm, problems };
}

function main() {
  const dist = join(
    web,
    process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : 'dist',
  );
  const now = measure(dist);
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(baselinePath, `${JSON.stringify({ entryGzipBytes: now.gzip }, null, 2)}\n`);
    console.log(`bundle baseline set: ${now.entry} ${now.gzip} B gzip`);
    return;
  }
  const { entryGzipBytes } = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const over = now.gzip - entryGzipBytes;
  const line = `entry ${now.entry}: ${now.gzip} B gzip (baseline ${entryGzipBytes} B, ${over >= 0 ? '+' : ''}${over} B; budget +${BUDGET} B)`;
  if (over > BUDGET) {
    console.error(`bundle check FAILED: ${line}`);
    console.error(
      'Something heavy reached the entry chunk. Lazy-load it, or raise the baseline on purpose with --update-baseline.',
    );
    process.exit(1);
  }
  console.log(`bundle check ok: ${line}`);

  const pre = checkPrecache(dist);
  const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
  const preLine = `${pre.entries} entries, ${kib(pre.bytes)} without the wasm (budget ${kib(PRECACHE_BUDGET)}), wasm ${kib(pre.wasm)} (budget ${kib(WASM_BUDGET)})`;
  if (pre.problems.length > 0) {
    console.error(`precache check FAILED: ${preLine}`);
    for (const p of pre.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`precache check ok: ${preLine}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
