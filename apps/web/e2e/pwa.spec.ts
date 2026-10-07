/**
 * The PWA shell against the built app and the real server (plan T23): the service worker
 * installs, the shell reloads offline, nothing authenticated is cached (D181), the manifest is
 * served as one, a share-target POST is handed to the page (D140), the catalogue in use is kept
 * for offline, and no page load breaks the CSP. Reads only: it never sets the instance up, so it
 * can share the flow instances with flow.spec.ts.
 */
import { expect, type Page, test } from '@playwright/test';

// Every test records CSP violations from the first script on, and fails if there are any: the
// CSP has no 'unsafe-inline', so an injected <style> or inline script shows up here first.
declare global {
  interface Window {
    __cspViolations?: string[];
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations?.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}`);
    });
  });
});
test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
});

async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

/** The paths in every cache, or only in the caches whose name contains `only`. */
const cachedPaths = (page: Page, only = '') =>
  page.evaluate(async (only) => {
    const out: string[] = [];
    for (const name of (await caches.keys()).filter((n) => n.includes(only))) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) out.push(new URL(req.url).pathname);
    }
    return out;
  }, only);

test('the service worker installs, and the shell reloads offline', async ({ page, context }) => {
  await page.goto('/');
  await controlled(page);
  // Something authenticated went over the network while online (the app's own /api calls).
  await page.evaluate(() => fetch('/api/v1/setup').then((r) => r.status));

  const cached = await cachedPaths(page);
  expect(cached).toContain('/index.html');
  expect(cached.some((p) => p.endsWith('.woff2'))).toBe(true);
  expect(cached.filter((p) => /^\/(?:api|f)(?:\/|$)/.test(p))).toEqual([]);
  // Icon chunks and catalogues are cached on first use, never precached.
  const precached = await cachedPaths(page, 'precache');
  expect(precached).toContain('/index.html');
  expect(precached.filter((p) => /^\/assets\/(?:icons|locales)\//.test(p))).toEqual([]);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page).toHaveTitle('Kept');
    await expect(page.locator('#root')).not.toBeEmpty();
    // A deep link offline gets the precached shell too.
    await page.goto('/things/offline-deep-link');
    await expect(page.locator('#root')).not.toBeEmpty();
    // The API is NetworkOnly: offline it fails instead of answering from a cache.
    const api = await page.evaluate(() =>
      fetch('/api/v1/setup').then(
        (r) => r.status,
        () => 'network-error',
      ),
    );
    expect(api).toBe('network-error');
  } finally {
    await context.setOffline(false);
  }
});

test('the manifest is served as a manifest, with the share target', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^application\/manifest\+json/);
  expect(res.headers()['cache-control']).toBe('no-cache');
  const manifest = await res.json();
  expect(manifest.share_target).toMatchObject({ action: '/share', method: 'POST' });
  const sw = await request.get('/sw.js');
  expect(sw.headers()['cache-control']).toBe('no-cache');
});

test('a share POST is answered by the worker and handed to the page once', async ({ page }) => {
  await page.goto('/');
  await controlled(page);
  const result = await page.evaluate(async () => {
    const form = new FormData();
    form.append('title', 'Receipt');
    form.append('files', new File(['%PDF-1.7'], 'receipt.pdf', { type: 'application/pdf' }));
    form.append('files', new File(['text'], 'notes.txt', { type: 'text/plain' }));
    const res = await fetch('/share', { method: 'POST', body: form });
    const id = new URL(res.url).searchParams.get('shared');
    const take = () =>
      new Promise<{ share: { title: string; files: { name: string }[] } | null }>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolve(e.data);
        navigator.serviceWorker.controller?.postMessage({ type: 'KEPT_TAKE_SHARE', id }, [
          channel.port2,
        ]);
      });
    const first = await take();
    const second = await take();
    return {
      path: new URL(res.url).pathname,
      id,
      title: first.share?.title,
      files: first.share?.files.map((f) => f.name),
      second: second.share,
    };
  });
  expect(result.path).toBe('/capture');
  expect(result.id).toBeTruthy();
  expect(result.title).toBe('Receipt');
  expect(result.files).toEqual(['receipt.pdf']);
  expect(result.second).toBeNull();
});

test('a page load logs no CSP violations: setup and sign-in', async ({ page }) => {
  const logged: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/.test(m.text())) logged.push(m.text());
  });
  for (const path of ['/', '/signin']) {
    await page.goto(path);
    await expect(page.locator('#root')).not.toBeEmpty();
    // React Aria injects its pressable <style> once a pressable mounts; give it a moment.
    await page.waitForTimeout(500);
  }
  expect(logged).toEqual([]);
});

test('the language in use is kept on the first visit, and the shell opens in it offline', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('kept.locale', 'ar');
    } catch {}
  });
  await page.goto('/');
  await controlled(page);
  // The first visit loaded its catalogue before the worker controlled it; the page fetches it
  // again through the worker (register.ts), which keeps it in kept-locales.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const c = await caches.open('kept-locales');
        return (await c.keys()).map((r) => new URL(r.url).pathname);
      }),
    )
    .toEqual([expect.stringMatching(/^\/assets\/locales\/messages-/)]);

  await context.setOffline(true);
  try {
    await page.reload();
    // The pre-paint script ran (CSP hash), in Arabic, right to left.
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
    // The first render is in Arabic, from the cached catalogue.
    await expect(page.locator('#root')).toContainText(/[\u0600-\u06FF]/);
  } finally {
    await context.setOffline(false);
  }
});
