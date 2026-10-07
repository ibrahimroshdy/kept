/**
 * Kept labels recognised in any capture mode (D137; plan T25): every 400 ms a downscaled copy of
 * the frame goes to the scanner, and a Kept code in view is reported, so the screen can offer
 * "Open Box 3" · "Capture into Box 3". It never reads a code aloud or fetches anything: the name
 * comes from the phone's snapshot.
 *
 * The scanner is a `Detect` function. By default it is the browser's own `BarcodeDetector` (QR
 * only) where there is one; T26's ZXing scanner (`camera/scanner.ts`, lazy wasm) is passed in by
 * the screen once it exists. Without either, recognition is simply off; the shutter still works.
 */
import { parseScan } from '@kept/shared';

export type Detected = { rawValue: string; format: string };
export type Detect = (source: CanvasImageSource) => Promise<Detected[]>;

/** The long edge of the frame the scanner sees (V12: 640 px is the slow-phone fallback). */
export const RECOGNISE_MAX_SIDE = 640;
export const RECOGNISE_EVERY_MS = 400;

type NativeDetector = { detect: (source: CanvasImageSource) => Promise<Detected[]> };
type NativeCtor = new (opts: { formats: string[] }) => NativeDetector;

/** The browser's `BarcodeDetector`, reading QR codes; null where there is none. */
export function nativeDetect(): Detect | null {
  const Ctor = (globalThis as { BarcodeDetector?: NativeCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const detector = new Ctor({ formats: ['qr_code'] });
    return (source) => detector.detect(source);
  } catch {
    return null;
  }
}

/** The Kept code in what the scanner read, if any (any host's `/l/<code>`, or the bare code). */
export function keptCodeIn(found: readonly Detected[]): string | null {
  for (const d of found) {
    const r = parseScan(d.rawValue, d.format);
    if (r.kind === 'kept') return r.code;
  }
  return null;
}

/**
 * Looks at `video` every `every` ms and reports the Kept code in view (null when it leaves).
 * Answers a stop function. A slow scan is never overlapped: the next look waits for it.
 */
export function watchForLabels(
  video: HTMLVideoElement,
  detect: Detect,
  onCode: (code: string | null) => void,
  { every = RECOGNISE_EVERY_MS, maxSide = RECOGNISE_MAX_SIDE } = {},
): () => void {
  let stopped = false;
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const canvas = document.createElement('canvas');
  const tick = async () => {
    if (stopped) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h) {
      const k = Math.min(1, maxSide / Math.max(w, h));
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      const ctx = canvas.getContext('2d');
      let code: string | null = null;
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          code = keptCodeIn(await detect(canvas));
        } catch {
          code = null;
        }
      }
      if (!stopped && code !== last) {
        last = code;
        onCode(code);
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), every);
  };
  timer = setTimeout(() => void tick(), every);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
