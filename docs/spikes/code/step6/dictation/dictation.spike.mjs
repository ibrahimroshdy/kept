/**
 * Spike S6.6 (V13), mic-free. Drives probe.html through Playwright (`@playwright/test` 1.63.0, the
 * workspace's own, resolved from apps/web), served from a loopback HTTP server.
 *
 * NEVER calls a real SpeechRecognition's start(). A first version did, with Chromium's fake-media
 * flags, and Chrome's recogniser opened the Mac's real microphone anyway (see the spike note).
 * So this version runs two things only:
 *   1. detection in real desktop Chromium builds: which constructors exist, the static
 *      `available`, whether `lang` keeps a bare interface language (`en`, `ar`, `fr`, `de`, `it`):
 *      construct, set `lang`, read it back; no start(), so no capture;
 *   2. the probe's event handling against a stubbed recogniser (an init script replaces
 *      `SpeechRecognition` and `webkitSpeechRecognition` before the page runs): interim then
 *      final results, stop(), and a permission denial (`not-allowed`).
 * Browsers launch with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` anyway.
 *
 * Run:  node dictation.spike.mjs      Writes results-<date>.json beside this file.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '../../../../../apps/web/package.json');
const { chromium } = createRequire(web)('@playwright/test');

const page = readFileSync(path.join(here, 'probe.html'));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const FAKE_MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

// A scripted recogniser. Scenario comes from `window.__scenario` ('speech' | 'denied').
function installStub() {
  class FakeRecognition extends EventTarget {
    lang = '';
    interimResults = false;
    continuous = false;
    maxAlternatives = 1;
    onresult = null;
    onerror = null;
    onend = null;
    #timers = [];
    #ended = false;
    #emit(type, extra = {}) {
      const e = Object.assign(new Event(type), extra);
      this.dispatchEvent(e);
      const h = this[`on${type}`];
      if (typeof h === 'function') h.call(this, e);
    }
    #later(ms, fn) {
      this.#timers.push(setTimeout(fn, ms));
    }
    #end() {
      if (this.#ended) return;
      this.#ended = true;
      for (const t of this.#timers) clearTimeout(t);
      this.#emit('end');
    }
    #result(text, isFinal) {
      const alt = { transcript: text, confidence: 0.9 };
      const res = Object.assign([alt], { isFinal });
      this.#emit('result', { resultIndex: 0, results: [res] });
    }
    start() {
      const scenario = window.__scenario ?? 'speech';
      this.#later(5, () => this.#emit('start'));
      if (scenario === 'denied') {
        this.#later(10, () => {
          this.#emit('error', { error: 'not-allowed', message: '' });
          this.#end();
        });
        return;
      }
      const words = window.__words ?? ['where', 'where is', 'where is the drill'];
      this.#later(10, () => this.#emit('audiostart'));
      this.#later(20, () => this.#emit('speechstart'));
      words.forEach((w, i) => this.#later(30 + i * 10, () => this.#result(w, false)));
      this.#later(30 + words.length * 10, () => this.#result(words.at(-1), true));
      this.#later(40 + words.length * 10, () => this.#emit('speechend'));
      this.#later(50 + words.length * 10, () => this.#end());
    }
    stop() {
      this.#later(1, () => this.#end());
    }
    abort() {
      this.#end();
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
}

const BROWSERS = [
  { name: 'Google Chrome (installed)', launch: { channel: 'chrome' } },
  { name: 'Chrome for Testing (Playwright chromium-1243)', launch: {} },
];
const LANGS = ['en', 'ar', 'fr', 'de', 'it', 'ar-EG'];

const results = { date: new Date().toLocaleDateString('en-CA'), detection: [], stubbed: [] };

for (const b of BROWSERS) {
  const browser = await chromium.launch({ ...b.launch, headless: true, args: FAKE_MEDIA });
  try {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${origin}/`);
    const support = await p.evaluate(() => window.support);
    const langs = await p.evaluate((ls) => {
      const C = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      return ls.map((l) => {
        const r = new C();
        r.lang = l;
        return { set: l, kept: r.lang };
      });
    }, LANGS);
    results.detection.push({ browser: b.name, version: browser.version(), support, langs });
  } finally {
    await browser.close();
  }
}

{
  const browser = await chromium.launch({ headless: true, args: FAKE_MEDIA });
  try {
    for (const c of [
      { scenario: 'speech', lang: 'en', words: ['where', 'where is', 'where is the drill'] },
      { scenario: 'speech', lang: 'ar', words: ['أين', 'أين المثقاب'] },
      { scenario: 'speech', lang: 'en', opts: { stopAfterMs: 15 } },
      { scenario: 'denied', lang: 'en' },
    ]) {
      const context = await browser.newContext();
      await context.addInitScript(installStub);
      await context.addInitScript(([s, w]) => {
        window.__scenario = s;
        if (w) window.__words = w;
      }, [c.scenario, c.words ?? null]);
      const p = await context.newPage();
      await p.goto(`${origin}/`);
      const r = await p.evaluate(([l, o]) => window.probe(l, o), [c.lang, c.opts ?? {}]);
      results.stubbed.push({ ...c, result: r });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
server.close();
writeFileSync(path.join(here, `results-${results.date}.json`), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 1));
