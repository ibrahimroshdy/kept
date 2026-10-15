#!/usr/bin/env node
// Try Kept (D246): the headless check of the demo as the docs site serves it. It serves the built
// docs site (apps/docs/dist, from `pnpm docs:build`) the way GitHub Pages does (a file, a
// directory's index.html, or 404), and in headless Chromium from apps/web's @playwright/test:
//
// - the landing page, Try the map and the Try Kept page load nothing of the app;
// - "Open Kept" opens it under /try/kept/app/ with the docs theme and language;
// - Home → a location → a thing → Search → Labels, by clicking, then Reset, at 1280 and 375 px,
//   light and dark, in English, and once more in Arabic at each width;
// - no console error, no failed request, no request to another host, no service worker, the
//   app's page `noindex`, and nothing left in IndexedDB afterwards.
//
// No device is ever asked for: before the app loads, the camera, the microphone, the position,
// notifications, passkeys and persistent storage are replaced with stubs that record a call
// (any call fails the check), and the browser is given no permissions.
//
//   pnpm docs:build && node scripts/check-try-kept.mjs [--shots <dir>]
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = createRequire(`${root}apps/web/package.json`)('@playwright/test');
const dist = `${root}apps/docs/dist/`;
const APP = '/try/kept/app/';
const at = process.argv.indexOf('--shots');
const shots = at > 0 ? process.argv[at + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
if (!existsSync(`${dist}try/kept/app/index.html`)) {
  console.error('apps/docs/dist/try/kept/app/ is missing: run `pnpm docs:build` first');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

/** GitHub Pages: a file, or a directory's index.html; anything else is the site's 404. */
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  let file = join(dist, decodeURIComponent(pathname));
  if (file.startsWith(dist) && existsSync(file) && statSync(file).isDirectory())
    file = join(file, 'index.html');
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.statusCode = 404;
    res.setHeader('content-type', TYPES['.html']);
    createReadStream(`${dist}404.html`).pipe(res);
    return;
  }
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Runs in every page before its scripts: every device API records the call and refuses. */
function stubDevices() {
  const asked = (what) => {
    window.__keptDevices = [...(window.__keptDevices ?? []), what];
  };
  const refuse = (what) => async () => {
    asked(what);
    throw new DOMException(`${what} is stubbed`, 'NotAllowedError');
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: refuse('camera or microphone'),
      getDisplayMedia: refuse('screen'),
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (_ok, fail) => {
        asked('location');
        fail?.({ code: 1, message: 'stubbed' });
      },
      watchPosition: () => {
        asked('location');
        return 0;
      },
      clearWatch() {},
    },
  });
  class Recognition {
    start() {
      asked('microphone (speech)');
    }
    stop() {}
    abort() {}
    addEventListener() {}
    removeEventListener() {}
  }
  window.SpeechRecognition = Recognition;
  window.webkitSpeechRecognition = Recognition;
  if (window.Notification) window.Notification.requestPermission = refuse('notifications');
  if (navigator.credentials) {
    navigator.credentials.create = refuse('passkey');
    navigator.credentials.get = refuse('passkey');
  }
  if (navigator.storage) navigator.storage.persist = refuse('persistent storage');
}

const browser = await chromium.launch({ headless: true });
const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);

async function context({ width, theme }) {
  const phone = width < 768;
  const ctx = await browser.newContext({
    viewport: { width, height: phone ? 812 : 800 },
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
    permissions: [],
  });
  await ctx.addInitScript(stubDevices);
  // Nothing may leave for another host: such a request is stopped and recorded.
  await ctx.route(
    (url) => url.origin !== origin && url.protocol !== 'data:' && url.protocol !== 'blob:',
    (route) => {
      ctx.foreign = [...(ctx.foreign ?? []), route.request().url()];
      return route.abort();
    },
  );
  return ctx;
}

/** Console errors, uncaught errors and failed responses on a page, under a label. */
function watch(page, label) {
  const where = () => `${label} ${page.url().replace(origin, '')}`;
  page.on('console', (m) => {
    if (m.type() === 'error') fail(where(), `console: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => fail(where(), `page error: ${String(e).slice(0, 300)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) fail(where(), `${r.status()} ${r.url().replace(origin, '')}`);
  });
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(origin)) fail(where(), `failed ${r.url().replace(origin, '')}`);
  });
}

async function shot(page, name) {
  if (!shots) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** The docs pages other than Try Kept's app: none of them may load anything from it. */
async function docsPagesLoadNoApp() {
  const ctx = await context({ width: 1280, theme: 'light' });
  const page = await ctx.newPage();
  watch(page, 'docs');
  const fromApp = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${origin}${APP}`)) fromApp.push(r.url());
  });
  for (const path of ['/', '/ar/', '/try/map/', '/try/kept/', '/ar/try/kept/']) {
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    if (fromApp.length) fail(`docs ${path}`, `loaded the app: ${fromApp.join(', ')}`);
    fromApp.length = 0;
    const robots = await page.locator('meta[name="robots"]').count();
    if (robots) fail(`docs ${path}`, 'has a robots meta tag (should be indexable)');
  }
  // The landing page links to Try Kept beside Try the map, in both languages.
  for (const [path, href] of [
    ['/', '/try/kept/'],
    ['/ar/', '/ar/try/kept/'],
  ]) {
    await page.goto(`${origin}${path}`);
    if (!(await page.locator(`.kd-hero-actions a[href="${href}"]`).count()))
      fail(`docs ${path}`, `no hero link to ${href}`);
  }
  if (ctx.foreign?.length) fail('docs', `requests to other hosts: ${ctx.foreign.join(', ')}`);
  await ctx.close();
}

/** Clicks the first visible element of a locator. */
async function clickFirst(page, selector, what) {
  const all = page.locator(selector);
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (await el.isVisible()) {
      await el.click();
      return;
    }
  }
  throw new Error(`no visible ${what} (${selector})`);
}

async function waitForHash(page, fragment) {
  await page.waitForFunction((f) => location.hash.includes(f), fragment, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
}

async function walk({ width, theme, lang }) {
  const label = `${lang} ${width} ${theme}`;
  const name = (step) => `${lang}-${width}-${theme}-${step}`;
  const phone = width < 768;
  const ctx = await context({ width, theme });
  const page = await ctx.newPage();
  watch(page, label);
  try {
    // The docs page, then its button, as a visitor would.
    await page.goto(`${origin}${lang === 'ar' ? '/ar' : ''}/try/kept/`, {
      waitUntil: 'networkidle',
    });
    await shot(page, name('0-docs'));
    await clickFirst(page, 'a.kd-btn[data-try-kept]', 'Open Kept button');
    await page.waitForURL((url) => url.pathname === APP, { timeout: 15_000 });
    await page.locator('[data-try-banner]').waitFor({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    const app = await page.evaluate(() => ({
      search: location.search,
      dir: document.documentElement.dir,
      theme: document.documentElement.dataset.theme,
      robots: document.querySelector('meta[name="robots"]')?.getAttribute('content'),
      manifest: document.querySelectorAll('link[rel="manifest"]').length,
    }));
    if (app.search) fail(label, `the address kept ${app.search}`);
    if (app.dir !== (lang === 'ar' ? 'rtl' : 'ltr')) fail(label, `direction is ${app.dir}`);
    if (app.theme !== theme) fail(label, `theme is ${app.theme}, the docs page was ${theme}`);
    if (app.robots !== 'noindex') fail(label, `the app's robots meta is ${app.robots}`);
    if (app.manifest) fail(label, 'the app links a web app manifest');
    const workers = await page.evaluate(async () =>
      'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    );
    if (workers) fail(label, `${workers} service worker(s) registered`);
    await shot(page, name('1-home'));

    // A location: the household's Home (المنزل in Arabic), from the Home page's locations; its
    // address ends in its id's tail (src/api/mock/fixtures.ts).
    await clickFirst(page, 'main a[href*="#/loc/"][href$="0000b002"]', 'location link');
    await waitForHash(page, '/loc/');
    await shot(page, name('2-location'));

    // A named thing in it: one with a short ID in its address (a draft's is its UUID).
    await clickFirst(page, 'main a[href*="#/t/"]:not([href*="-"])', 'thing link');
    await waitForHash(page, '/t/');
    await shot(page, name('3-thing'));

    // Search: the tab on a phone; the palette, then "Search for …", on a computer.
    const words = 'cable';
    if (phone) {
      await clickFirst(page, 'nav a[href$="#/search"]', 'Search tab');
      await waitForHash(page, '/search');
      await page.locator('main input').first().fill(words);
    } else {
      await page.keyboard.press('Control+k');
      const box = page.getByRole('dialog').locator('input').first();
      await box.waitFor();
      await box.fill(words);
      await page.waitForTimeout(500);
      await clickFirst(page, '[role="option"][id$="act_search"]', '"Search for" option');
    }
    await waitForHash(page, '/search');
    await page.waitForTimeout(800);
    const hits = await page.locator('main a[href*="#/t/"]').count();
    if (!hits) fail(label, `searching "${words}" found nothing`);
    await shot(page, name('4-search'));

    // Labels: the sidebar on a computer, More on a phone.
    if (phone) {
      await clickFirst(page, 'nav a[href$="#/more"]', 'More tab');
      await waitForHash(page, '/more');
    }
    await clickFirst(page, 'a[href*="#/labels"]', 'Labels link');
    await waitForHash(page, '/labels');
    await shot(page, name('5-labels'));

    // Reset: back to Home, the sample as it started.
    await clickFirst(page, '[data-try-banner] button', 'Reset');
    await page.waitForFunction(() => location.hash === '#/', null, { timeout: 15_000 });
    await page.locator('[data-try-banner]').waitFor({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    const devices = await page.evaluate(() => window.__keptDevices ?? []);
    if (devices.length) fail(label, `asked for: ${devices.join(', ')}`);
    if (ctx.foreign?.length) fail(label, `requests to other hosts: ${ctx.foreign.join(', ')}`);

    // Nothing kept: no database of the app's in the real IndexedDB (the docs page sees it).
    await page.goto(`${origin}/try/kept/`);
    const dbs = await page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('kept')),
    );
    if (dbs.length) fail(label, `left IndexedDB databases: ${dbs.join(', ')}`);
    console.log(`ok ${label}`);
  } catch (e) {
    fail(label, String(e).split('\n')[0]);
    await shot(page, name('x-failed')).catch(() => {});
  } finally {
    await ctx.close();
  }
}

try {
  await docsPagesLoadNoApp();
  for (const width of [1280, 375]) {
    for (const theme of ['light', 'dark']) await walk({ width, theme, lang: 'en' });
    await walk({ width, theme: 'light', lang: 'ar' });
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`check-try-kept: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('check-try-kept: every walk passed');
