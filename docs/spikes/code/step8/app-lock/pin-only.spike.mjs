// Spike L1: the PIN path alone, for a run under `taskpolicy -b` (macOS background QoS: the
// efficiency cores; Chromium's child processes inherit it). CDP CPU throttling does not slow
// WebCrypto (app-lock.spike.mjs shows it), so this is the slower-core proxy.
// Run: taskpolicy -b node pin-only.spike.mjs 2850000 >> results-pin-only-2026-10-06.jsonl
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadavg } from 'node:os';
import { chromium } from 'playwright';

const n = Number(process.argv[2] ?? 2850000);
const html = readFileSync(new URL('page.html', import.meta.url));
const server = createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://localhost:${server.address().port}/`);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ms = [];
await page.evaluate(() => window.probe.pbkdf2Ms(10000));
for (let i = 0; i < 5; i++) ms.push(await page.evaluate((n) => window.probe.pbkdf2Ms(n), n));
const spin = (await page.evaluate(() => window.probe.spinMs())).ms;
await browser.close();
server.close();
console.log(JSON.stringify({ at: new Date().toISOString(), label: process.env.L1_LABEL ?? 'default', chromium: browser.version(), iterations: n, medianMs: +med(ms).toFixed(1), spinMs: +spin.toFixed(1), loadavg: loadavg().map((x) => +x.toFixed(1)) }));
