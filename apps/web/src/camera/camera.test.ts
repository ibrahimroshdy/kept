/**
 * The device helpers behind capture (plan T25): the camera's failure names, the photo policy's
 * sizes, the on-device location suggestion (D153: never a request), and the label reader.
 */
import type { SnapLocation } from '@kept/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentPosition,
  distanceM,
  nearestLocation,
  setSuggestWhere,
  suggestWhereOn,
} from './geo';
import { fitWithin, fromFile } from './image';
import { keptCodeIn } from './label-recogniser';
import { classifyCameraError, openCamera, problemUpfront } from './session';

const loc = (id: string, lat?: number, lon?: number, radius = 150): SnapLocation => ({
  id,
  name: id,
  kind: 'apartment',
  timezone: 'Africa/Cairo',
  languages: ['en'],
  role: 'owner',
  effectiveModules: [],
  unplacedPlaceId: `${id}-unplaced`,
  ...(lat !== undefined && lon !== undefined ? { latitude: lat, longitude: lon } : {}),
  suggestRadiusM: radius,
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the camera session', () => {
  it('names each reason the camera can’t open', () => {
    expect(problemUpfront({ secure: false, media: null })).toBe('insecure');
    expect(problemUpfront({ secure: true, media: null })).toBe('unsupported');
    expect(classifyCameraError(new DOMException('no', 'NotAllowedError'))).toBe('denied');
    expect(classifyCameraError(new DOMException('no', 'NotFoundError'))).toBe('no_camera');
    expect(classifyCameraError(new DOMException('no', 'NotReadableError'))).toBe('busy');
    expect(classifyCameraError(new Error('?'))).toBe('failed');
  });

  it('asks for the back camera at up to 4K, and reports a refusal', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    expect(await openCamera({ secure: true, media: { getUserMedia } })).toEqual({
      ok: false,
      problem: 'denied',
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  });
});

describe('the photo policy (D34, D36)', () => {
  it('shrinks to fit the long edge, never enlarging', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it('keeps a file it can’t decode as it is, with "preview unavailable"', async () => {
    const heic = new Blob(['heic'], { type: 'image/heic' });
    const decode = vi.fn().mockRejectedValue(new Error('no HEIC here'));
    const receipt = await fromFile(heic, 'receipt', decode);
    expect(receipt).toEqual({ original: heic, display: null, previewUnavailable: true });
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    expect((await fromFile(pdf, 'receipt', decode)).original).toBe(pdf);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe('"Suggest where I am" (D153)', () => {
  const home = loc('home', 30.0444, 31.2357);
  const garage = loc('garage', 30.05, 31.24, 150);
  const personal = loc('personal');

  it('measures on the device and picks the nearest location within its radius', () => {
    expect(
      Math.round(distanceM({ latitude: 30, longitude: 31 }, { latitude: 30.001, longitude: 31 })),
    ).toBe(111);
    expect(
      nearestLocation({ latitude: 30.0445, longitude: 31.2358 }, [garage, home, personal])?.id,
    ).toBe('home');
    expect(nearestLocation({ latitude: 29, longitude: 31 }, [home, garage, personal])).toBeNull();
  });

  it('reads the position once, and never sends it anywhere', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const geo = {
      getCurrentPosition: vi.fn((ok: PositionCallback) =>
        ok({ coords: { latitude: 30.0444, longitude: 31.2357 } } as GeolocationPosition),
      ),
    };
    expect(await currentPosition(geo)).toEqual({
      ok: true,
      position: { latitude: 30.0444, longitude: 31.2357 },
    });
    const denied = {
      getCurrentPosition: vi.fn((_ok: PositionCallback, err?: PositionErrorCallback | null) =>
        err?.({ code: 1 } as GeolocationPositionError),
      ),
    };
    expect(await currentPosition(denied)).toEqual({ ok: false, reason: 'denied' });
    expect(await currentPosition(null)).toEqual({ ok: false, reason: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('remembers only the on/off choice', () => {
    expect(suggestWhereOn()).toBe(false);
    setSuggestWhere(true);
    expect(suggestWhereOn()).toBe(true);
    expect(Object.keys(localStorage)).toEqual(['kept.capture.suggestWhere']);
    setSuggestWhere(false);
    expect(suggestWhereOn()).toBe(false);
  });
});

describe('label recognition (D137)', () => {
  it('finds a Kept code in what the scanner read, from any host', () => {
    expect(keptCodeIn([{ rawValue: 'https://kept.example.org/l/3KD7PX', format: 'qr_code' }])).toBe(
      '3KD7PX',
    );
    expect(keptCodeIn([{ rawValue: 'WIFI:S:home;;', format: 'qr_code' }])).toBeNull();
    expect(keptCodeIn([])).toBeNull();
  });
});
