/**
 * The scanner (D101, D137; plan T26, V12): one decoder for the whole app. Scan, the box check's
 * "Found something else" and the capture camera's label recognition (T25) all read through
 * `appDetect()`.
 *
 * - **The decoder:** the browser's own `BarcodeDetector` where it reads QR codes (Android
 *   Chrome); otherwise `barcode-detector`'s ponyfill with the self-hosted ZXing wasm (./zxing.ts),
 *   loaded on the first scan, never with the page. Every iPhone takes the wasm path.
 * - **Formats:** Kept labels are QR codes; products carry EAN-13, EAN-8, UPC-A or UPC-E; Code 128
 *   is on many shop and asset labels.
 * - **The loop:** `requestVideoFrameCallback` where there is one, else `requestAnimationFrame`,
 *   throttled to about 8 frames a second on a downscaled copy of the frame, and never two decodes
 *   at once (V12 falls back to 4 fps and 640 px on slow phones).
 * - **A failure means "no scanner":** a decoder that can't start (the wasm refused, as under a CSP
 *   without `'wasm-unsafe-eval'`, or a chunk that isn't cached) is `ScannerUnavailable`, and the
 *   screen leads with "Type the code".
 */
import type { Detect, Detected } from './label-recogniser';

/** What the scanner reads (BarcodeDetector format names). */
export const SCAN_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] as const;

/** About 8 decodes a second (V12). */
export const SCAN_FPS = 8;
/** The long edge of the frame the decoder sees. */
export const SCAN_MAX_SIDE = 960;
/** V12's fallback for older phones, if the device check shows the loop can't keep up. */
export const SLOW_PHONE = { fps: 4, maxSide: 640 } as const;

/** The decoder can't run on this device: the screen offers "Type the code" instead. */
export class ScannerUnavailable extends Error {
  constructor(cause?: unknown) {
    super('Barcode scanning is unavailable on this device.');
    this.name = 'ScannerUnavailable';
    if (cause !== undefined) this.cause = cause;
  }
}

type NativeDetector = { detect: (source: CanvasImageSource) => Promise<Detected[]> };
type NativeCtor = {
  new (opts: { formats: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

/** The browser's `BarcodeDetector`, if it reads QR codes; null otherwise. */
export async function nativeScanner(
  scope: { BarcodeDetector?: unknown } = globalThis as { BarcodeDetector?: unknown },
): Promise<Detect | null> {
  const Ctor = scope.BarcodeDetector as NativeCtor | undefined;
  if (typeof Ctor !== 'function') return null;
  try {
    const supported = (await Ctor.getSupportedFormats?.()) ?? [];
    if (!supported.includes('qr_code')) return null;
    const detector = new Ctor({ formats: SCAN_FORMATS.filter((f) => supported.includes(f)) });
    return async (source) =>
      (await detector.detect(source)).map((d) => ({ rawValue: d.rawValue, format: d.format }));
  } catch {
    return null;
  }
}

/** The wasm reader, fetched with its chunk the first time it is needed. */
export const loadWasmScanner = async (): Promise<Detect> =>
  (await import('./zxing')).zxingDetect(SCAN_FORMATS);

const unsupported = (e: unknown) =>
  !!e && typeof e === 'object' && 'name' in e && e.name === 'NotSupportedError';

/**
 * A `Detect` that picks its decoder on the first call: the native one when it reads QR codes,
 * else the wasm. A decoder that can't start, or refuses as unsupported, throws
 * `ScannerUnavailable` from then on.
 */
export function createDetect({
  native = nativeScanner,
  wasm = loadWasmScanner,
}: {
  native?: () => Promise<Detect | null>;
  wasm?: () => Promise<Detect>;
} = {}): Detect {
  let chosen: Promise<Detect> | null = null;
  const pick = () => {
    chosen ??= (async () => {
      try {
        return (await native()) ?? (await wasm());
      } catch (e) {
        throw new ScannerUnavailable(e);
      }
    })();
    return chosen;
  };
  return async (source) => {
    const detect = await pick();
    try {
      return await detect(source);
    } catch (e) {
      if (unsupported(e)) throw new ScannerUnavailable(e);
      throw e;
    }
  };
}

let shared: Detect | null = null;

/** The app's one decoder (Scan, box check, capture's label recognition). */
export function appDetect(): Detect {
  shared ??= createDetect();
  return shared;
}

// ----- the loop ---------------------------------------------------------------------------------

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type ScanLoopOptions = {
  fps?: number;
  maxSide?: number;
  /** The decoder couldn't start: the loop has stopped. */
  onUnavailable?: (e: ScannerUnavailable) => void;
  now?: () => number;
};

/**
 * Decodes what `video` shows, about `fps` times a second, and reports every frame that read
 * something. Answers a stop function. The frame's canvas is created with `willReadFrequently`,
 * because the ponyfill reads its pixels back on every decode (the spike's Chromium warning).
 */
export function startScanLoop(
  video: HTMLVideoElement,
  detect: Detect,
  onRead: (found: Detected[]) => void,
  {
    fps = SCAN_FPS,
    maxSide = SCAN_MAX_SIDE,
    onUnavailable,
    now = () => performance.now(),
  }: ScanLoopOptions = {},
): () => void {
  const v = video as FrameVideo;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const every = 1000 / fps;
  let stopped = false;
  let busy = false;
  let last = Number.NEGATIVE_INFINITY;
  let handle: number | null = null;
  const byFrame = typeof v.requestVideoFrameCallback === 'function';

  const schedule = () => {
    if (stopped) return;
    handle = byFrame
      ? (v.requestVideoFrameCallback?.(tick) ?? null)
      : requestAnimationFrame(() => tick());
  };
  const decode = async () => {
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!ctx || !w || !h) return;
    const k = Math.min(1, maxSide / Math.max(w, h));
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(h * k);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    try {
      const found = await detect(canvas);
      if (!stopped && found.length > 0) onRead(found);
    } catch (e) {
      if (e instanceof ScannerUnavailable) {
        stopped = true;
        onUnavailable?.(e);
      }
      // Anything else is one bad frame; the next one tries again.
    }
  };
  function tick() {
    if (stopped) return;
    const t = now();
    if (!busy && t - last >= every) {
      last = t;
      busy = true;
      void decode().finally(() => {
        busy = false;
      });
    }
    schedule();
  }
  schedule();
  return () => {
    stopped = true;
    if (handle === null) return;
    if (byFrame) v.cancelVideoFrameCallback?.(handle);
    else cancelAnimationFrame(handle);
  };
}

/** A short buzz on a read, where the phone can (Android; iPhones have no `vibrate`). */
export function buzz(): void {
  try {
    navigator.vibrate?.(30);
  } catch {
    // A nicety only.
  }
}

// ----- the diagnostics probe (T23's panel; V12 and the Safari CSP question) ---------------------

/**
 * Decodes a QR code drawn on a canvas with the wasm reader, twice: whether the wasm runs here at
 * all (Safari under `'wasm-unsafe-eval'`, which the spike could only assume), how long the first
 * decode takes with the wasm's compile, and how long a frame takes after (V12's "fast enough on
 * older iPhones"). Facts only, for the copied report; nothing is sent.
 */
export async function probeWasmScanner(): Promise<{ ok: boolean; facts: string[] }> {
  const text = 'https://kept.example/l/7KQ4MZ';
  try {
    const [{ encode }, { zxingDetect }] = await Promise.all([import('uqr'), import('./zxing')]);
    const qr = encode(text, { border: 4 });
    const scale = 4;
    const canvas = document.createElement('canvas');
    canvas.width = qr.size * scale;
    canvas.height = qr.size * scale;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { ok: false, facts: ['wasm=no-canvas'] };
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (const [y, row] of qr.data.entries())
      for (const [x, on] of row.entries()) if (on) ctx.fillRect(x * scale, y * scale, scale, scale);
    const detect = zxingDetect(['qr_code']);
    const t0 = performance.now();
    const first = await detect(canvas);
    const t1 = performance.now();
    await detect(canvas);
    const t2 = performance.now();
    const ok = first[0]?.rawValue === text;
    return {
      ok,
      facts: [
        `wasm=${ok ? 'reads' : 'no-read'}`,
        `first=${Math.round(t1 - t0)}ms`,
        `frame=${Math.round(t2 - t1)}ms`,
      ],
    };
  } catch (e) {
    const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : 'error';
    return { ok: false, facts: [`wasm=failed:${name}`] };
  }
}
