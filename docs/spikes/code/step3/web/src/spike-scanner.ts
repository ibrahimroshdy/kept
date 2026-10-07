// SPIKE (step 3, T0): the ZXing wasm scanner under Kept's CSP.
// barcode-detector 3.2.2 bundles its own copy of zxing-wasm's reader (dist/es/zxing-exported.js),
// so the overrides must go through the ponyfill's re-exported prepareZXingModule, not a separate
// `zxing-wasm/reader` import (that would configure a different module instance).
import {
  BarcodeDetector,
  prepareZXingModule,
  ZXING_WASM_SHA256,
  ZXING_WASM_VERSION,
} from 'barcode-detector/ponyfill';
import { encode } from 'uqr';
// zxing-wasm must be a direct dependency pinned to barcode-detector's own zxing-wasm version
// (3.1.3), or pnpm won't resolve this import and the JS glue and wasm could drift apart.
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

declare global {
  interface Window {
    __scan?: {
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
  }
}

const TEXT = 'https://kept.example/l/K7Q2XM';

function drawQr(canvas: HTMLCanvasElement) {
  const { data, size } = encode(TEXT, { border: 0 });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const quiet = 4; // modules of white margin
  const px = Math.floor(canvas.width / (size + quiet * 2));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  const off = Math.floor((canvas.width - px * size) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y]?.[x]) ctx.fillRect(off + x * px, off + y * px, px, px);
    }
  }
}

async function run() {
  const canvas = document.getElementById('qr') as HTMLCanvasElement;
  drawQr(canvas);
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasmUrl : prefix + path,
    },
  });
  const detector = new BarcodeDetector({
    formats: ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  });
  const t0 = performance.now();
  const first = await detector.detect(canvas);
  const coldMs = performance.now() - t0;
  const N = 20;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) await detector.detect(canvas);
  const warmMs = (performance.now() - t1) / N;
  window.__scan = {
    ok: first.length > 0,
    texts: first.map((b) => b.rawValue),
    formats: first.map((b) => b.format),
    coldMs,
    warmMs,
    wasmUrl,
    version: ZXING_WASM_VERSION,
    sha256: ZXING_WASM_SHA256,
    nativeDetector: 'BarcodeDetector' in window,
  };
}

run().catch((e: unknown) => {
  window.__scan = { ok: false, error: String(e) };
});
