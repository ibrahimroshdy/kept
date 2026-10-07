/**
 * What the phone does with a photo before it queues (D34, D36, D117; plan T25, Q20; @kept/shared
 * `PHOTO_POLICY`):
 *
 * - **THING:** the photo is shrunk to 2048 px on the long edge, JPEG q0.85, and that JPEG is the
 *   only upload (the `original`). The full-size photo is never kept.
 * - **RECEIPT, LABEL, READING:** the photo is evidence. A camera frame is encoded at full track
 *   resolution, JPEG q0.92, and becomes the `original`; a file (the system camera, the gallery,
 *   a share) is kept **byte for byte**. Both get a 2048 px `display` JPEG made here, because the
 *   server can't decode HEIC and the phone can (V10).
 * - **When the phone can't decode a file** (a HEIC on a browser without it, a PDF): the file
 *   goes as it is, with no display, and the server shows "preview unavailable" (D36). Never
 *   rejected.
 *
 * Only canvas and `createImageBitmap`, so it works in every browser Kept supports; a decoder is
 * injectable for tests.
 */
import { type CaptureMode, newId, PHOTO_POLICY } from '@kept/shared';
import type { LocalBlob } from '@/offline/store';

export const JPEG_QUALITY = { thing: 0.85, evidence: 0.92, display: 0.85 } as const;

/** A photo ready to queue: the upload, and the phone-made display for evidence modes. */
export type CapturedImage = {
  original: Blob;
  display: Blob | null;
  /** The phone couldn't decode it, so there is no display (D36 "preview unavailable"). */
  previewUnavailable: boolean;
};

/** A picture the canvas can draw, with its size. */
export type Drawable = { source: CanvasImageSource; width: number; height: number };

/** Decodes a file into something drawable; `createImageBitmap` by default. */
export type Decode = (blob: Blob) => Promise<Drawable>;

export const decodeWithBitmap: Decode = async (blob) => {
  if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap');
  const bitmap = await createImageBitmap(blob);
  return { source: bitmap, width: bitmap.width, height: bitmap.height };
};

/** The size that fits `max` on the long edge, never enlarged. */
export function fitWithin(width: number, height: number, max: number) {
  const long = Math.max(width, height);
  if (long <= max || long === 0) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Draws `img` onto a new canvas, shrunk to `max` on the long edge when given. */
export function drawScaled(img: Drawable, max?: number): HTMLCanvasElement {
  const size = max ? fitWithin(img.width, img.height, max) : img;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  ctx.drawImage(img.source, 0, 0, size.width, size.height);
  return canvas;
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the canvas made no JPEG'))),
      'image/jpeg',
      quality,
    );
  });
}

const evidence = (mode: CaptureMode) => PHOTO_POLICY[mode].keepOriginal;
const shrinkTo = (mode: CaptureMode) => {
  const policy = PHOTO_POLICY[mode];
  return policy.keepOriginal ? policy.displayTo : policy.shrinkTo;
};

/** A camera frame (already drawn at full resolution) → the blobs its mode keeps. */
export async function fromFrame(frame: Drawable, mode: CaptureMode): Promise<CapturedImage> {
  if (!evidence(mode)) {
    const original = await canvasToJpeg(drawScaled(frame, shrinkTo(mode)), JPEG_QUALITY.thing);
    return { original, display: null, previewUnavailable: false };
  }
  const original = await canvasToJpeg(drawScaled(frame), JPEG_QUALITY.evidence);
  const display = await canvasToJpeg(drawScaled(frame, shrinkTo(mode)), JPEG_QUALITY.display);
  return { original, display, previewUnavailable: false };
}

/**
 * A picked or shared file → the blobs its mode keeps. Evidence originals are the file itself;
 * a THING photo is re-encoded small, or kept as it is when it can't be decoded.
 */
export async function fromFile(
  file: Blob,
  mode: CaptureMode,
  decode: Decode = decodeWithBitmap,
): Promise<CapturedImage> {
  let img: Drawable | null = null;
  if (file.type.startsWith('image/') || file.type === '') {
    try {
      img = await decode(file);
    } catch {
      img = null;
    }
  }
  if (!img) return { original: file, display: null, previewUnavailable: true };
  try {
    const small = await canvasToJpeg(
      drawScaled(img, shrinkTo(mode)),
      evidence(mode) ? JPEG_QUALITY.display : JPEG_QUALITY.thing,
    );
    return evidence(mode)
      ? { original: file, display: small, previewUnavailable: false }
      : { original: small, display: null, previewUnavailable: false };
  } catch {
    return { original: file, display: null, previewUnavailable: true };
  } finally {
    if (typeof ImageBitmap !== 'undefined' && img.source instanceof ImageBitmap) img.source.close();
  }
}

/** The file's SHA-256 as 64 lower-case hex characters (`X-Kept-Sha256`). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The queue's blobs for one image, each with the upload id chosen now, so a retry replays the
 * same file (T24's uploader pairs the display with its original through `displayFileId`).
 */
export async function toLocalBlobs(
  img: CapturedImage,
  ids: () => string = newId,
): Promise<{ original: LocalBlob; display: LocalBlob | null }> {
  const original: LocalBlob = {
    id: ids(),
    kind: 'original',
    blob: img.original,
    sha256: await sha256Hex(img.original),
  };
  const display: LocalBlob | null = img.display
    ? { id: ids(), kind: 'display', blob: img.display, sha256: await sha256Hex(img.display) }
    : null;
  return { original, display };
}
