/**
 * The ZXing-C++ wasm reader behind `barcode-detector`'s ponyfill (D101; spike
 * docs/spikes/2026-09-26-step3-scanner-wasm.md). Loaded only by `scanner.ts`'s dynamic import,
 * the first time a scan needs it, so neither the glue nor the 1.1 MB wasm is in the entry chunk.
 * The wasm is self-hosted and precached by the service worker (vite.config.ts), so scanning works
 * offline and nothing is fetched from a CDN.
 *
 * `prepareZXingModule` must come from the ponyfill: it bundles its own copy of zxing-wasm's reader,
 * and the one in `zxing-wasm/reader` would configure a second, unused module (the spike's third
 * correction). Without `locateFile` the ponyfill fetches the wasm from jsDelivr.
 */
import { BarcodeDetector, type BarcodeFormat, prepareZXingModule } from 'barcode-detector/ponyfill';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { Detect } from './label-recogniser';

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? wasmUrl : prefix + path,
  },
});

/** A `Detect` reading `formats` with the wasm reader. */
export function zxingDetect(formats: readonly string[]): Detect {
  const detector = new BarcodeDetector({ formats: formats as BarcodeFormat[] });
  return async (source) =>
    (await detector.detect(source as Parameters<typeof detector.detect>[0])).map((d) => ({
      rawValue: d.rawValue,
      format: d.format,
    }));
}
