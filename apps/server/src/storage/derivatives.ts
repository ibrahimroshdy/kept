import path from 'node:path';
import sharp from 'sharp';
import type { Sniffed } from './sniff.js';

// Derivatives (engineering spec §3.4, §7.2; D34, D36, D77, D117, D157; plan Q8, Q17).
//
// The original stays byte-identical (D117). What the app shows is made from it here: rotated
// upright from the EXIF orientation, shrunk to fit, and re-encoded as JPEG, which drops every
// metadata block (EXIF, GPS, XMP, IPTC) because sharp writes none unless asked (`withMetadata`,
// `keepMetadata`, `withExif` are never called here). Images only:
// - JPEG, PNG, WebP, AVIF and GIF (the first frame) → `ready`, with display, thumb and share;
// - HEIC/HEIF → `unavailable`: sharp's prebuilt libvips can't decode HEVC (D36, D99). The phone
//   makes the display JPEG in step 3 (D34); the upload is never refused for it;
// - PDF → `not_applicable` in step 2: thumbnails and text wait for the step-3 child-process
//   parser (Q8);
// - an image sharp can't decode (corrupt, or over the pixel limit) → `unavailable`: the bytes
//   passed the magic-byte check and are still the user's evidence, so they are kept.
//
// Resizing runs in the upload request (Q17), a few at a time process-wide (ImageLimiter), with a
// pixel limit on every decode (D157), so a decompression bomb can't take a Pi down. The original
// is decoded once: the display rendition is made from it, and the share and thumb renditions
// from the display, which is already upright and at most 2048 px (security review #15). A full
// queue refuses the next upload (ImageBusyError, a 503 with Retry-After) rather than letting
// requests, and their spooled bodies, pile up behind it.

/** D157: no decode above 40 megapixels (an 8000 × 5000 image; phones shoot 12–48 MP, and a
 * 4-channel decode of 40 MP is 160 MB, already a lot for a Pi; security review #15). */
export const LIMIT_INPUT_PIXELS = 40_000_000;

/** The longest side of each rendition (§3.4). */
export const VARIANT_SIZES = { display: 2048, share: 1200, thumb: 400 } as const;
export type ImageVariant = keyof typeof VARIANT_SIZES;
export const IMAGE_VARIANTS = Object.keys(VARIANT_SIZES) as ImageVariant[];

const JPEG_QUALITY = 82;

export type DerivativeState = 'ready' | 'unavailable' | 'not_applicable';

export type MadeVariant = {
  variant: ImageVariant;
  /** The rendition's temp file, beside the upload; the caller stores and removes it. */
  path: string;
  width: number;
  height: number;
  bytes: number;
};

export type Derived = {
  state: DerivativeState;
  /** As shown: after the EXIF orientation. Null when the image couldn't be read. */
  width: number | null;
  height: number | null;
  /** Whether the original carries a GPS block (D117's export warning). */
  hasGps: boolean;
  variants: MadeVariant[];
};

// ---------------------------------------------------------------------------------------------
// A process-wide limit on concurrent resizing (KEPT_IMAGE_CONCURRENCY, Q17)
// ---------------------------------------------------------------------------------------------

/** The image queue is full: try again shortly (the upload route answers 503, Retry-After). */
export class ImageBusyError extends Error {
  constructor() {
    super('too many images are waiting to be resized');
    this.name = 'ImageBusyError';
  }
}

/** Jobs that may wait for a slot, per slot, unless the constructor says otherwise. */
const WAITING_PER_SLOT = 8;

export class ImageLimiter {
  readonly size: number;
  /** How many jobs may wait; one more is refused with ImageBusyError. */
  readonly maxWaiting: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number, maxWaiting = size * WAITING_PER_SLOT) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('an image limit is at least 1');
    if (!Number.isInteger(maxWaiting) || maxWaiting < 0) {
      throw new RangeError('a queue length is a whole number');
    }
    this.size = size;
    this.maxWaiting = maxWaiting;
  }

  /** Whether a job would be refused now (checked before an upload's body is read). */
  get full(): boolean {
    return this.#active >= this.size && this.#waiting.length >= this.maxWaiting;
  }

  /** How many jobs are running now (tests). */
  get active(): number {
    return this.#active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.full) throw new ImageBusyError();
    if (this.#active >= this.size) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      // The slot passes straight to the next waiter, so #active never dips and overshoots.
      if (next) next();
      else this.#active -= 1;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// GPS: a small IFD walker over the EXIF block sharp hands back
// ---------------------------------------------------------------------------------------------

const GPS_IFD_POINTER = 0x8825;

/** Whether an EXIF block's IFD0 points at a GPS IFD (tag 0x8825). `exif` is sharp's
 * `metadata().exif`: `Exif\0\0` then a TIFF header. Malformed input is simply `false`. */
export function exifHasGps(exif: Buffer | undefined | null): boolean {
  if (!exif || exif.length < 8) return false;
  const base = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0;
  if (exif.length < base + 8) return false;
  const order = exif.subarray(base, base + 2).toString('latin1');
  const le = order === 'II';
  if (!le && order !== 'MM') return false;
  const u16 = (at: number) => (le ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
  const u32 = (at: number) => (le ? exif.readUInt32LE(at) : exif.readUInt32BE(at));
  if (u16(base + 2) !== 42) return false;
  const ifd0 = base + u32(base + 4);
  if (ifd0 + 2 > exif.length) return false;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > exif.length) return false;
    if (u16(entry) === GPS_IFD_POINTER) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Making the renditions
// ---------------------------------------------------------------------------------------------

/** Formats sharp's prebuilt binaries decode. */
const DECODABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

/** Width, height (upright) and GPS of an image, or nulls when sharp can't read its header.
 * metadata() reads the header only, never the pixels, so the pixel limit isn't needed here
 * (and would hide the size of the very image it refuses to decode). */
async function probe(file: string): Promise<Pick<Derived, 'width' | 'height' | 'hasGps'>> {
  try {
    const meta = await sharp(file, { limitInputPixels: false }).metadata();
    return {
      width: meta.autoOrient?.width ?? meta.width ?? null,
      height: meta.autoOrient?.height ?? meta.height ?? null,
      hasGps: exifHasGps(meta.exif),
    };
  } catch {
    return { width: null, height: null, hasGps: false };
  }
}

async function render(file: string, variant: ImageVariant, out: string): Promise<MadeVariant> {
  const side = VARIANT_SIZES[variant];
  const info = await sharp(file, { limitInputPixels: LIMIT_INPUT_PIXELS, autoOrient: true })
    .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
    // JPEG has no alpha: transparent PNG/WebP/GIF areas become white, not black.
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(out);
  return { variant, path: out, width: info.width, height: info.height, bytes: info.size };
}

/**
 * The derivatives of the upload at `file` (already sniffed). Renditions are written beside it as
 * `<file>.<variant>.jpg`. Call it inside the limiter: `limiter.run(() => derive(…))`.
 */
export async function derive(file: string, sniffed: Sniffed): Promise<Derived> {
  if (sniffed.kind !== 'image') {
    return { state: 'not_applicable', width: null, height: null, hasGps: false, variants: [] };
  }
  const shape = await probe(file);
  if (!DECODABLE.has(sniffed.mime)) return { ...shape, state: 'unavailable', variants: [] };
  const variants: MadeVariant[] = [];
  try {
    // Largest first, from the original; the rest from that display rendition (review #15).
    const display = await render(file, 'display', `${file}.display.jpg`);
    variants.push(display);
    for (const variant of IMAGE_VARIANTS) {
      if (variant === 'display') continue;
      variants.push(await render(display.path, variant, `${file}.${variant}.jpg`));
    }
  } catch {
    return { ...shape, state: 'unavailable', variants: [] };
  }
  return { ...shape, state: 'ready', variants };
}

/** The temp files derive() may have written for `file`, for clean-up. */
export function derivativeTempPaths(file: string): string[] {
  return IMAGE_VARIANTS.map((v) => `${file}.${v}.jpg`).map((p) => path.normalize(p));
}
