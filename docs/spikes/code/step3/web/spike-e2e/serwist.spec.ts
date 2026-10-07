// SPIKE (step 3, T0, V17): @serwist/vite on Vite 8 (rolldown).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

type Entry = { url: string; revision: string | null };

function manifestOf(): Entry[] {
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  // The injected manifest is minified into the IIFE as {url:`…`,revision:`…`|null} literals.
  return [...sw.matchAll(/\{url:`([^`]+)`,revision:(null|`[^`]*`)\}/g)].map((m) => ({
    url: m[1] ?? '',
    revision: m[2] === 'null' ? null : (m[2] ?? '').slice(1, -1),
  }));
}

test('dist/sw.js carries a precache manifest with hashed assets, fonts and the zxing wasm', () => {
  const entries = manifestOf();
  const urls = entries.map((e) => e.url);
  const bytes = urls.reduce((n, u) => n + statSync(join(dist, u)).size, 0);
  const iconChunks = readdirSync(join(dist, 'assets', 'icons')).length;
  console.log(
    JSON.stringify({
      entries: urls.length,
      precacheBytes: bytes,
      js: urls.filter((u) => u.endsWith('.js')).length,
      woff2: urls.filter((u) => u.endsWith('.woff2')).length,
      wasm: urls.filter((u) => u.endsWith('.wasm')),
      html: urls.filter((u) => u.endsWith('.html')),
      iconChunksNotPrecached: iconChunks,
    }),
  );
  expect(urls).toContain('index.html');
  // The entry is main-*.js here only because the spike build has three inputs (main, scanner, hints).
  expect(urls.some((u) => /^assets\/(index|main)-[\w-]{8}\.js$/.test(u))).toBe(true);
  expect(urls.some((u) => u.endsWith('.woff2'))).toBe(true);
  expect(urls.some((u) => /zxing_reader-[\w-]{8}\.wasm$/.test(u))).toBe(true);
  expect(urls.some((u) => u.startsWith('assets/icons/'))).toBe(false);
  // Fingerprinted assets need no revision (dontCacheBustURLsMatching defaults to ^assets/).
  expect(entries.find((e) => e.url.startsWith('assets/'))?.revision).toBeNull();
  expect(entries.find((e) => e.url === 'index.html')?.revision).not.toBeNull();
});

async function install(page: Page, base: string) {
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.__spikeSw?.registered === true, null, {
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // clientsClaim: the first load becomes controlled without a reload.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 30_000,
  });
}

for (const base of ['http://localhost:4173', 'http://127.0.0.1:4198']) {
  test(`installs and serves the shell offline (${base})`, async ({ page, context }) => {
    await install(page, base);
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        for (const r of await c.keys()) out.push(`${name} ${new URL(r.url).pathname}`);
      }
      return out;
    });
    console.log(`${base} cached entries: ${cached.length}`);
    expect(cached.some((c) => c.endsWith('/index.html') || c.includes('/index.html?'))).toBe(true);

    // /api is NetworkOnly: online it answers, and nothing under /api or /f reaches a cache.
    if (base.includes('4198')) {
      const ok = await page.evaluate(async () => (await fetch('/api/ping')).ok);
      expect(ok).toBe(true);
    }
    const afterApi = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        for (const r of await c.keys()) out.push(new URL(r.url).pathname);
      }
      return out;
    });
    expect(afterApi.some((p) => p.startsWith('/api/') || p.startsWith('/f/'))).toBe(false);

    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle('Kept');
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0);
    // A deep SPA route offline gets the precached index.html (navigateFallback).
    await page.goto(`${base}/things/some-id`);
    await expect(page).toHaveTitle('Kept');
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0);
    // /api offline fails (NetworkOnly), it is not answered from a cache.
    const apiOffline = await page.evaluate(async () => {
      try {
        await fetch('/api/ping');
        return 'answered';
      } catch {
        return 'failed';
      }
    });
    expect(apiOffline).toBe('failed');
    await context.setOffline(false);
  });
}

test('a new worker waits; messageSkipWaiting() hands over (D148)', async ({ page, request }) => {
  const base = 'http://127.0.0.1:4198';
  await install(page, base);
  await request.get(`${base}/__bump`);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  });
  await page.waitForFunction(() => (window.__spikeSw?.waiting ?? 0) > 0, null, { timeout: 30_000 });
  // It stays waiting until the page says so.
  await page.waitForTimeout(1000);
  expect(
    await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting),
  ).toBe(true);
  await page.evaluate(() => window.__spikeSkipWaiting?.());
  await page.waitForFunction(() => (window.__spikeSw?.controlling ?? 0) > 0, null, {
    timeout: 30_000,
  });
});

declare global {
  interface Window {
    __spikeSw?: { waiting: number; controlling: number; registered: boolean; error?: string };
    __spikeSkipWaiting?: () => void;
  }
}
