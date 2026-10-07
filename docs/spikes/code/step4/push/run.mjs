// Step-4 spike T0: web push in Playwright's Chromium. Serves index.html and sw.js on localhost
// (a secure context), grants notifications, tries pushManager.subscribe() with a VAPID key from
// web-push's generateVAPIDKeys(), and then delivers a push through the Chrome DevTools Protocol
// (ServiceWorker.deliverPushMessage {origin, registrationId, data}, as playwright-core 1.63.0's
// types/protocol.d.ts defines it). Run: node run.mjs (from this directory).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const webRequire = createRequire(path.join(repo, 'apps/web/package.json'));
const serverRequire = createRequire(path.join(repo, 'apps/server/package.json'));
const { chromium } = webRequire('@playwright/test');
const webpush = serverRequire('web-push');

const files = { '/': ['index.html', 'text/html'], '/sw.js': ['sw.js', 'text/javascript'] };
const srv = http.createServer((req, res) => {
  const f = files[req.url];
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': f[1] }).end(readFileSync(path.join(here, f[0])));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${srv.address().port}`;
const vapid = webpush.generateVAPIDKeys();

async function attempt(headless, channel) {
  const out = { headless, channel: channel ?? 'playwright chromium' };
  const browser = await chromium.launch({ headless, ...(channel ? { channel } : {}) });
  try {
    out.version = browser.version();
    const context = await browser.newContext();
    await context.grantPermissions(['notifications'], { origin });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => window.ready);
    out.permission = await page.evaluate(() => Notification.permission);
    // Chromium keeps push as its own permission ({name: 'push', userVisibleOnly: true}); set it
    // through CDP Browser.setPermission, which Playwright's grantPermissions() doesn't cover.
    try {
      const bcdp = await browser.newBrowserCDPSession();
      await bcdp.send('Browser.setPermission', { permission: { name: 'push', userVisibleOnly: true }, setting: 'granted', origin });
      out.pushPermissionSet = true;
    } catch (e) {
      out.pushPermissionSet = String(e.message ?? e).split('\n')[0];
    }
    out.pushPermissionState = await page.evaluate(async () => (await navigator.serviceWorker.ready).pushManager.permissionState({ userVisibleOnly: true }));
    out.subscribe = await page.evaluate(async (key) => {
      const reg = await navigator.serviceWorker.ready;
      try {
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const j = sub.toJSON();
        return { ok: true, endpointHost: new URL(j.endpoint).host, keys: Object.keys(j.keys ?? {}) };
      } catch (e) {
        return { ok: false, error: `${e.name}: ${e.message}` };
      }
    }, vapid.publicKey);

    // CDP: find the registration, deliver a push, see the worker's handler run.
    const cdp = await context.newCDPSession(page);
    const regs = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { if (e.registrations.length) resolve(e.registrations); }));
    await cdp.send('ServiceWorker.enable');
    const [reg] = await regs;
    out.registration = { scopeURL: reg.scopeURL, hasId: typeof reg.registrationId === 'string' };
    const data = JSON.stringify({ k: 'reminder', url: '/things/abc' });
    await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data });
    await page.waitForFunction(() => window.pushes.length > 0, null, { timeout: 5000 });
    out.cdpPush = await page.evaluate(() => window.pushes);
    out.notifications = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body })));
  } catch (e) {
    out.error = String(e.message ?? e).split('\n')[0];
  } finally {
    await browser.close();
  }
  return out;
}

// Headless only: the headless shell (Playwright's default) and full Chromium in new headless mode.
const results = [await attempt(true), await attempt(true, 'chromium')];
console.log(JSON.stringify(results, null, 2));
srv.close();
