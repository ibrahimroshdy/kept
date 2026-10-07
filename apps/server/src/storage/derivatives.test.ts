import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../../test/files.js';
import {
  derive,
  exifHasGps,
  ImageBusyError,
  ImageLimiter,
  LIMIT_INPUT_PIXELS,
} from './derivatives.js';

// T17: derivatives (D36, D117, D157; Q8, Q17), below the routes.

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kept-derive-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, bytes: Buffer): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return p;
}

describe('exifHasGps', () => {
  it('finds the GPS pointer in a phone-style EXIF block, little- and big-endian', async () => {
    const withGps = (await sharp(await fixture('photo.jpg')).metadata()).exif;
    expect(exifHasGps(withGps)).toBe(true);
    const noGps = (await sharp(await fixture('rotated.jpg')).metadata()).exif;
    expect(exifHasGps(noGps)).toBe(false);

    // A hand-made big-endian TIFF: IFD0 with one entry, 0x8825.
    const be = Buffer.alloc(8 + 2 + 12 + 4);
    be.write('MM', 0, 'latin1');
    be.writeUInt16BE(42, 2);
    be.writeUInt32BE(8, 4);
    be.writeUInt16BE(1, 8);
    be.writeUInt16BE(0x8825, 10);
    expect(exifHasGps(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), be]))).toBe(true);
  });

  it('is false for nothing, garbage and truncated blocks, never throwing', () => {
    expect(exifHasGps(undefined)).toBe(false);
    expect(exifHasGps(Buffer.from('Exif\0\0'))).toBe(false);
    expect(exifHasGps(Buffer.from('Exif\0\0XX*\0\0\0\0\0', 'latin1'))).toBe(false);
    const huge = Buffer.from('Exif\0\0II*\0\xff\xff\xff\x7f', 'latin1');
    expect(exifHasGps(huge)).toBe(false);
    const manyEntries = Buffer.from('II*\0\x08\0\0\0\xff\xff', 'latin1');
    expect(exifHasGps(manyEntries)).toBe(false);
  });
});

describe('derive', () => {
  it('marks a JPEG it cannot decode as unavailable, keeping the upload (D36)', async () => {
    const photo = await fixture('photo.jpg');
    const broken = await file(
      'broken.jpg',
      Buffer.concat([photo.subarray(0, 40), Buffer.alloc(40)]),
    );
    const out = await derive(broken, { mime: 'image/jpeg', ext: 'jpg', kind: 'image' });
    expect(out.state).toBe('unavailable');
    expect(out.variants).toEqual([]);
  });

  it('refuses to decode past the pixel limit (D157): unavailable, not a crash', async () => {
    // A 1×1 PNG whose header claims 12,000 × 10,000: a decompression bomb's shape, cheaply.
    const bomb = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    // IHDR is the first chunk: length(4) 'IHDR'(4) width(4) height(4) … crc(4), from byte 8.
    bomb.writeUInt32BE(12_000, 16);
    bomb.writeUInt32BE(10_000, 20);
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    const p = await file('bomb.png', bomb);
    const out = await derive(p, { mime: 'image/png', ext: 'png', kind: 'image' });
    expect(out.state).toBe('unavailable');
    expect([out.width, out.height]).toEqual([12_000, 10_000]);
  });

  it('decodes nothing over 40 megapixels on a Pi-sized budget (review #15)', () => {
    expect(LIMIT_INPUT_PIXELS).toBe(40_000_000);
  });

  it('makes every rendition upright and within its size, the smaller ones from the display', async () => {
    // 3000 × 2000, EXIF orientation 6: shown as 2000 × 3000.
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const p = await file('big.jpg', big);
    const out = await derive(p, { mime: 'image/jpeg', ext: 'jpg', kind: 'image' });
    expect(out.state).toBe('ready');
    const size = Object.fromEntries(out.variants.map((v) => [v.variant, [v.width, v.height]]));
    // The thumb is scaled from the 1365-wide display, so it rounds to 266, not the original's 267.
    expect(size).toEqual({ display: [1365, 2048], share: [800, 1200], thumb: [266, 400] });
  });

  it('makes nothing for a PDF (Q8)', async () => {
    const p = await file('doc.pdf', await fixture('doc.pdf'));
    const out = await derive(p, { mime: 'application/pdf', ext: 'pdf', kind: 'pdf' });
    expect(out).toEqual({
      state: 'not_applicable',
      width: null,
      height: null,
      hasGps: false,
      variants: [],
    });
  });
});

describe('ImageLimiter (KEPT_IMAGE_CONCURRENCY, Q17)', () => {
  it('runs at most `size` jobs at once, in arrival order, and survives failures', async () => {
    const limiter = new ImageLimiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (n: number, fail = false) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        order.push(n);
        if (fail) throw new Error(`job ${n}`);
        return n;
      });
    const results = await Promise.allSettled([job(1), job(2, true), job(3), job(4), job(5)]);
    expect(peak).toBe(2);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(order.slice(0, 2).sort()).toEqual([1, 2]);
    expect(limiter.active).toBe(0);
  });

  it('refuses a job while its queue is full, rather than piling uploads up (review #15)', async () => {
    const limiter = new ImageLimiter(1, 1);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = limiter.run(() => held);
    const second = limiter.run(async () => 2);
    await expect(limiter.run(async () => 3)).rejects.toBeInstanceOf(ImageBusyError);
    release();
    await first;
    expect(await second).toBe(2);
    expect(limiter.active).toBe(0);
    // With room again, a job runs.
    expect(await limiter.run(async () => 4)).toBe(4);
  });

  it('needs a size of at least 1', () => {
    expect(() => new ImageLimiter(0)).toThrow(RangeError);
  });
});
