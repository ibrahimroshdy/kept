# Spike: the ZXing wasm scanner under Kept's CSP

Date: 2026-09-26. Step-3 plan, Task 0 (it feeds T2's CSP and T26's `camera/scanner.ts`).
Result: **proven, with three corrections to the plan:**
1. `script-src` needs `'wasm-unsafe-eval'`, confirmed both ways;
2. `zxing-wasm` must be a direct dependency pinned to **3.1.3**, not npm's latest;
3. `prepareZXingModule` must come from `barcode-detector/ponyfill`, not from `zxing-wasm/reader`.

Code: `docs/spikes/code/step3/web/` (`spike-scanner.html`, `src/spike-scanner.ts`,
`csp-server.mjs`, `spike-e2e/scanner.spec.ts`). Built with Vite 8.3.1 and checked in Chromium
through Playwright 1.63.0.

## Versions (checked with `npm view` on 2026-09-26)

| Package | Version | Licence | Notes |
|---|---|---|---|
| `barcode-detector` | 3.2.2 | MIT | depends on `zxing-wasm` **exactly `3.1.3`** |
| `zxing-wasm` | 3.1.3 (npm latest is 3.1.4) | MIT | pin **3.1.3** to match `barcode-detector`: the JS glue and the wasm are a pair |

## What was proven

- **A 400×400 QR on a canvas decodes.**
  - The QR was drawn with `uqr` and decoded with `new BarcodeDetector({formats: ['qr_code','ean_13','ean_8','upc_a','upc_e','code_128']}).detect(canvas)`.
  - It gave `rawValue` `https://kept.example/l/K7Q2XM` and `format` `qr_code`.
- **It is fast on a desktop.** Measured in headless Chromium on the maintainer's Mac (Apple M1 Pro):
  - the first `detect()` took **32–42 ms**, including fetching and compiling the wasm;
  - after that, **3.2–3.4 ms per frame**.

  This says nothing about older iPhones (V12 stays a device check).
- **`'wasm-unsafe-eval'` is required.** Under Kept's CSP as it is today
  (`default-src 'self'; script-src 'self' 'sha256-…'`), both of these are refused:
  - `WebAssembly.instantiateStreaming()`;
  - the glue's fallback, `WebAssembly.instantiate(ArrayBuffer)`.

  Chromium's message: *"violates the following Content Security policy directive because
  'unsafe-eval' is not an allowed source of script"*. `detect()` then rejects with
  `NotSupportedError: … Barcode detection service unavailable.`, and the wasm is fetched twice,
  once per attempt.

  With `'wasm-unsafe-eval'` added to `script-src`, it decodes. `instantiateStreaming` succeeds
  on the first try, with no "falling back to ArrayBuffer instantiation" message, when the wasm
  is served as `application/wasm`.
- **No network calls outside our origin.** The page's requests are the page, three same-origin
  JS chunks and `/assets/zxing_reader-<hash>.wasm`. Nothing went to jsDelivr.
- **The self-hosted wasm is the one the ponyfill expects.** The served file's SHA-256 (`shasum -a 256`) is
  `2ebda08a93eea3efcd8399cda6b276e6a0b1de4fec60b4d8988a047de4c6d1ba`. That equals the
  `ZXING_WASM_SHA256` export, and `ZXING_WASM_VERSION` is `3.1.3`.
- **Chromium has a native detector.** `'BarcodeDetector' in window` is `true` in Chromium on
  macOS. The spike used the ponyfill explicitly.

## Exact config (for T2 and T26)

**T2, `apps/server/src/http/app.ts` (helmet CSP).**
- Always send `scriptSrc`, including when there is no web bundle. Without the web bundle,
  `default-src 'self'` alone also blocks wasm.
- Add `'wasm-unsafe-eval'` to it:

```ts
scriptSrc: ["'self'", "'wasm-unsafe-eval'", ...(opts.web?.scriptHashes ?? [])],
```

`'wasm-unsafe-eval'` allows compiling WebAssembly only. It does not allow `eval()` or
`new Function()`, which stay blocked. Add a CSP header test for it.

**T26, `apps/web/src/camera/scanner.ts`.**

```ts
// barcode-detector bundles its own copy of zxing-wasm's reader (dist/es/zxing-exported.js), so the
// overrides must go through ITS prepareZXingModule. One from `zxing-wasm/reader` would configure a
// second, unused module instance, and the ponyfill would still fetch from the CDN.
import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
  },
});
```

- **`apps/web/package.json`** needs `"barcode-detector": "3.2.2"` **and** `"zxing-wasm": "3.1.3"`.
  pnpm doesn't hoist the transitive `zxing-wasm`, so without the direct dependency the `?url`
  import doesn't resolve.
- **Add a unit test** that the installed `zxing-wasm` version equals the ponyfill's
  `ZXING_WASM_VERSION`, so a later bump of one without the other fails CI instead of a phone.
- **Without `locateFile`, the ponyfill goes to a CDN.** The default fetches
  `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm`, as
  `barcode-detector`'s bundled glue shows. The host is `fastly.jsdelivr.net`, a jsDelivr mirror.
- **A failure means "no scanner".** Treat a `NotSupportedError` from `detect()` as "scanner
  unavailable": show manual entry, and have the diagnostics probe report it.
- **Create the frame canvas with `getContext('2d', {willReadFrequently: true})`.** Chromium warned
  about repeated `getImageData` readbacks. The ponyfill reads the canvas on every detect.
- **The wasm is precached** by T23's service worker, whose `globPatterns` must include `wasm`
  (see `2026-09-26-step3-serwist.md`). So scanning works offline.

## Still open (device)

- **Safari (iOS/macOS) honouring `'wasm-unsafe-eval'`** under this CSP. This is assumed, not
  checked here. It's in `2026-09-26-step3-devices.md`.
- **The frame rate on older iPhones** (V12).

## Fallback

None needed. Had `'wasm-unsafe-eval'` been unacceptable, the only way out is the native detector,
which exists on Android Chrome but not on iOS, plus manual code entry. The pure-JS
`@zxing/library` is maintenance-only, and D101 already rules it out.
