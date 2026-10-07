// Spike L1, the app lock. Headless Chromium (Playwright) + a CDP virtual authenticator, on a page
// served from localhost by this script. Never a real authenticator, camera or microphone.
// Run: npm ci && node app-lock.spike.mjs   (writes results-2026-10-06.json next to this file)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadavg } from 'node:os';
import { chromium } from 'playwright';

const here = new URL('.', import.meta.url);
const html = readFileSync(new URL('page.html', here));
const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const results = { date: new Date().toISOString(), loadavgStart: loadavg().map((x) => +x.toFixed(1)) };

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
results.playwright = JSON.parse(readFileSync(new URL('node_modules/playwright/package.json', here))).version;
results.chromium = browser.version();

const BASE = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};
const CASES = {
  prf: { ...BASE, hasPrf: true },
  hmacSecretOnly: { ...BASE, hasHmacSecret: true },
  noPrf: { ...BASE },
  uvFails: { ...BASE, hasPrf: true, isUserVerified: false },
  noUv: { ...BASE, hasUserVerification: false, isUserVerified: false },
};

async function withAuthenticator(options, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
  try {
    return await fn(page, cdp, authenticatorId);
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    await context.close();
  }
}

results.webauthn = {};
for (const [name, options] of Object.entries(CASES)) {
  results.webauthn[name] = await withAuthenticator(options, async (page, cdp, authenticatorId) => {
    const r = { options };
    r.capabilities = await page.evaluate(() => window.probe.capabilities());
    r.create = await page.evaluate(() => window.probe.create({ prfFirst: 'kept-create-probe' }));
    if (!r.create.ok) return r;
    const id = r.create.id;
    r.getA1 = await page.evaluate((id) => window.probe.get({ id, prfFirst: 'salt-A' }), id);
    r.getA2 = await page.evaluate((id) => window.probe.get({ id, prfFirst: 'salt-A', prfSecond: 'salt-B' }), id);
    r.getNoPrf = await page.evaluate((id) => window.probe.get({ id }), id);
    if (r.getA1.ok && r.getA1.prf?.firstHex) {
      r.prfDeterministic = r.getA1.prf.firstHex === r.getA2.prf?.firstHex;
      r.prfSaltSeparates = r.getA2.prf?.secondHex !== null && r.getA2.prf?.secondHex !== r.getA2.prf?.firstHex;
      r.prfWrap = await page.evaluate((h) => window.probe.prfWrap(h), r.getA1.prf.firstHex);
      // Hide the output values from the results file: only their length and equality matter.
      for (const g of [r.getA1, r.getA2]) if (g.prf) { g.prf.firstHex = g.prf.firstHex ? '<32 bytes>' : null; g.prf.secondHex = g.prf.secondHex ? '<32 bytes>' : null; }
    }
    // UV 'required' after the authenticator stops verifying: the assertion must fail.
    if (name === 'prf') {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
      r.getAfterUvOff = await page.evaluate((id) => window.probe.get({ id, prfFirst: 'salt-A' }), id);
    }
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    r.storedCredentials = credentials.map((c) => ({ isResidentCredential: c.isResidentCredential, rpId: c.rpId, signCount: c.signCount }));
    return r;
  });
}

// The PIN path. One page, no authenticator.
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(url);
const cdp = await ctx.newCDPSession(page);
const series = async (n, runs = 5) => {
  const ms = [];
  for (let i = 0; i < runs; i++) ms.push(await page.evaluate((n) => window.probe.pbkdf2Ms(n), n));
  return +med(ms).toFixed(1);
};
await series(10000, 2); // warm-up
const pin = { calibration: {} };
for (const n of [100000, 300000, 600000]) pin.calibration[n] = await series(n);
// Iterations for ~300 ms, from the 600k point, rounded down to 50k.
const perIter = pin.calibration[600000] / 600000;
pin.target = Math.floor(300 / perIter / 50000) * 50000;
pin.targetMs = await series(pin.target, 7);
pin.wrap = await page.evaluate((n) => window.probe.pinWrap(n), pin.target);
pin.spinMs = +(await page.evaluate(() => window.probe.spinMs())).ms.toFixed(1);

await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
pin.throttled4x = {
  spinMs: +(await page.evaluate(() => window.probe.spinMs())).ms.toFixed(1),
  targetMs: await series(pin.target, 5),
};
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
results.pin = pin;
await ctx.close();
await browser.close();
server.close();

// Node, and node on the efficiency cores (`taskpolicy -b`, the repo's bench:pi-speed proxy).
const nodeRun = (cmd, args) => JSON.parse(execFileSync(cmd, args, { cwd: new URL('.', import.meta.url) }).toString());
results.node = nodeRun(process.execPath, ['node-pbkdf2.mjs', String(pin.target), '5']);
results.nodeEfficiencyCores = nodeRun('/usr/sbin/taskpolicy', ['-b', process.execPath, 'node-pbkdf2.mjs', String(pin.target), '3']);
results.loadavgEnd = loadavg().map((x) => +x.toFixed(1));

writeFileSync(new URL('results-2026-10-06.json', here), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
