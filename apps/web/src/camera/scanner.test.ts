/**
 * The scanner's choices and loop (plan T26): the native detector only where it reads QR codes, the
 * wasm otherwise, "no scanner" when neither can start, and a loop that decodes about 8 frames a
 * second, never two at once, and stops for good when the decoder is unavailable. The decoders are
 * fakes here; scanner.decode.test.ts runs the real wasm on fixture images.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Detect } from './label-recogniser';
import { createDetect, nativeScanner, ScannerUnavailable, startScanLoop } from './scanner';

const qr = { rawValue: 'https://kept.example/l/7KQ4MZ', format: 'qr_code' };
const canvas = {} as CanvasImageSource;

function nativeCtor(formats: string[]) {
  const detect = vi.fn(async () => [qr]);
  const Ctor = vi.fn(function (this: unknown, _opts: { formats: string[] }) {
    return { detect };
  }) as unknown as {
    new (o: { formats: string[] }): unknown;
    getSupportedFormats(): Promise<string[]>;
  };
  Ctor.getSupportedFormats = async () => formats;
  return { Ctor, detect };
}

describe('the decoder', () => {
  it('uses the native detector where it reads QR codes, asking for the formats it has', async () => {
    const { Ctor } = nativeCtor(['qr_code', 'ean_13', 'aztec']);
    const detect = await nativeScanner({ BarcodeDetector: Ctor });
    expect(await detect?.(canvas)).toEqual([qr]);
    expect(Ctor).toHaveBeenCalledWith({ formats: ['qr_code', 'ean_13'] });
  });

  it('takes no native detector without QR support, or without one at all', async () => {
    expect(await nativeScanner({ BarcodeDetector: nativeCtor(['ean_13']).Ctor })).toBeNull();
    expect(await nativeScanner({})).toBeNull();
  });

  it('falls back to the wasm, loaded once, on the first scan', async () => {
    const wasmDetect = vi.fn<Detect>(async () => [qr]);
    const wasm = vi.fn(async () => wasmDetect);
    const detect = createDetect({ native: async () => null, wasm });
    expect(wasm).not.toHaveBeenCalled();
    await detect(canvas);
    await detect(canvas);
    expect(wasm).toHaveBeenCalledTimes(1);
    expect(wasmDetect).toHaveBeenCalledTimes(2);
  });

  it('is unavailable when the wasm cannot load or the reader refuses', async () => {
    const noChunk = createDetect({
      native: async () => null,
      wasm: async () =>
        Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    });
    await expect(noChunk(canvas)).rejects.toBeInstanceOf(ScannerUnavailable);
    const refused = createDetect({
      native: async () => null,
      wasm: async () => async () => {
        throw new DOMException('Barcode detection service unavailable.', 'NotSupportedError');
      },
    });
    await expect(refused(canvas)).rejects.toBeInstanceOf(ScannerUnavailable);
  });
});

describe('the loop', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeVideo() {
    const frames: (() => void)[] = [];
    const video = Object.assign(document.createElement('video'), {
      requestVideoFrameCallback: (cb: () => void) => frames.push(cb),
      cancelVideoFrameCallback: vi.fn(),
    });
    Object.defineProperty(video, 'videoWidth', { value: 1920 });
    Object.defineProperty(video, 'videoHeight', { value: 1080 });
    const frame = () => frames.shift()?.();
    return { video, frame };
  }

  it('decodes about 8 frames a second on a downscaled frame, reporting what it read', async () => {
    const drawn: number[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return { drawImage: () => drawn.push(this.width) } as never;
    });
    const { video, frame } = fakeVideo();
    let clock = 0;
    const detect = vi.fn<Detect>(async () => [qr]);
    const onRead = vi.fn();
    const stop = startScanLoop(video, detect, onRead, { now: () => clock });
    for (let i = 0; i < 60; i++) {
      clock += 1000 / 60;
      frame();
      await Promise.resolve();
      await Promise.resolve();
    }
    stop();
    // One second of 60 fps video: 8 decodes, give or take the first frame.
    expect(detect.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(detect.mock.calls.length).toBeLessThanOrEqual(9);
    expect(drawn[0]).toBe(960);
    expect(onRead).toHaveBeenCalledWith([qr]);
  });

  it('stops for good when the decoder is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => {},
    } as never);
    const { video, frame } = fakeVideo();
    let clock = 0;
    const detect = vi.fn<Detect>(async () => {
      throw new ScannerUnavailable();
    });
    const onUnavailable = vi.fn();
    startScanLoop(video, detect, vi.fn(), { now: () => clock, onUnavailable });
    for (let i = 0; i < 30; i++) {
      clock += 200;
      frame();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);
  });
});
