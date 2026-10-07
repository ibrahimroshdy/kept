// SPIKE (step 3, T0): barcode-detector's ponyfill with the self-hosted zxing wasm under Kept's CSP.
import { expect, test } from '@playwright/test';

type Scan = {
  ok: boolean;
  texts?: string[];
  formats?: string[];
  coldMs?: number;
  warmMs?: number;
  wasmUrl?: string;
  version?: string;
  sha256?: string;
  nativeDetector?: boolean;
  error?: string;
};

for (const [label, base, wasmAllowed] of [
  ['CSP with wasm-unsafe-eval', 'http://127.0.0.1:4198', true],
  ['CSP as today (no wasm-unsafe-eval)', 'http://127.0.0.1:4199', false],
] as const) {
  test(`scanner: ${label}`, async ({ page }) => {
    const requests: string[] = [];
    const console_: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));
    await page.goto(`${base}/spike-scanner.html`);
    const scan = (await (
      await page.waitForFunction(() => (window as unknown as { __scan?: Scan }).__scan, null, {
        timeout: 30_000,
      })
    ).jsonValue()) as Scan;
    console.log(label, JSON.stringify(scan));
    console.log(label, 'console:', JSON.stringify(console_));
    console.log(label, 'requests:', JSON.stringify(requests.map((u) => new URL(u).pathname)));
    const origin = new URL(base).origin;
    expect(requests.every((u) => u.startsWith(origin))).toBe(true);
    if (wasmAllowed) {
      expect(scan.ok).toBe(true);
      expect(scan.texts).toEqual(['https://kept.example/l/K7Q2XM']);
      expect(scan.formats).toEqual(['qr_code']);
      expect(requests.some((u) => /\/assets\/zxing_reader-[\w-]{8}\.wasm$/.test(u))).toBe(true);
      // instantiateStreaming worked first time: no fallback message from the emscripten glue.
      expect(console_.some((c) => c.includes('wasm streaming compile failed'))).toBe(false);
    } else {
      expect(scan.ok).toBe(false);
    }
  });
}
