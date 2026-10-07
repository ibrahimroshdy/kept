/**
 * What the provider receives (plan T10, Q12; D163, D202): GPS-free sources only, never the
 * original's bytes.
 *
 * - THING: the file's `display` derivative (2048 px, made without metadata, storage/
 *   derivatives.ts). A file with no display yet (a HEIC original whose phone display hasn't
 *   arrived) is re-encoded from the original at 2048 px if the server can decode it.
 * - RECEIPT, LABEL and READING: an in-memory re-encode of the original, upright, at most 3072 px
 *   on its longest side, JPEG quality 85, metadata dropped (sharp writes none unless asked). It is
 *   never stored. An original the server can't decode (HEIC, D36/D99) uses the phone-made
 *   `display` instead (T13).
 * - A PDF receipt sends its extracted text (`file_text`, T21) and no image.
 *
 * callModel checks every image part again (no EXIF, no XMP) and throws on a violation.
 */
import type { Readable } from 'node:stream';
import type { CaptureMode } from '@kept/shared';
import sharp from 'sharp';
import type { ImageInput } from '../ai/call.js';
import {
  BlobNotFoundError,
  type BlobStore,
  derivativeKey,
  originalKey,
} from '../storage/blob-store.js';
import { LIMIT_INPUT_PIXELS } from '../storage/derivatives.js';

/** The longest side of an evidence re-encode (Q12; D163 says "up to 3000 px"). */
export const EVIDENCE_MAX_PX = 3072;
/** THING's size: the display rendition's (§3.4). */
export const THING_MAX_PX = 2048;
const JPEG_QUALITY = 85;
/** Receipt pages sent in one call (Q13). */
export const MAX_RECEIPT_PAGES = 4;

export type SourceFile = {
  attachmentId: string;
  fileId: string;
  locationId: string;
  mime: string;
};

export type BuiltParts = {
  images: ImageInput[];
  /** A PDF receipt's text, sent instead of an image. */
  documentText?: string;
  /** Per image, whether it came from the phone-made display (a re-crop must not repeat on it). */
  fromDisplay: boolean[];
  /** Sources that gave nothing to send (no display, undecodable, a PDF without text yet). */
  missing: string[];
};

export type PartsDeps = {
  blobs: BlobStore;
  /** A PDF's extracted text (file_text), or null when there is none yet. */
  textOf: (fileId: string) => Promise<string | null>;
};

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function blob(blobs: BlobStore, key: string): Promise<Buffer | null> {
  try {
    return await readAll(await blobs.stream(key));
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
}

/** An upright JPEG of at most `max` px, with no metadata; null when sharp can't decode it. */
export async function reencode(
  bytes: Buffer,
  max: number,
  attachmentId?: string,
): Promise<ImageInput | null> {
  try {
    const { data, info } = await sharp(bytes, {
      limitInputPixels: LIMIT_INPUT_PIXELS,
      autoOrient: true,
    })
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      mediaType: 'image/jpeg',
      width: info.width,
      height: info.height,
      ...(attachmentId ? { attachmentId } : {}),
    };
  } catch {
    return null;
  }
}

/** The display derivative as an image part (already upright, ≤ 2048 px, no metadata). */
async function display(blobs: BlobStore, f: SourceFile): Promise<ImageInput | null> {
  const bytes = await blob(blobs, derivativeKey(f.fileId, 'display'));
  if (!bytes) return null;
  try {
    const m = await sharp(bytes).metadata();
    if (!m.width || !m.height) return null;
    return {
      bytes: new Uint8Array(bytes),
      mediaType: 'image/jpeg',
      width: m.width,
      height: m.height,
      attachmentId: f.attachmentId,
    };
  } catch {
    return null;
  }
}

/** The parts for one extraction. `files` are the attachments to send, in order. */
export async function partsFor(
  mode: CaptureMode,
  files: readonly SourceFile[],
  deps: PartsDeps,
): Promise<BuiltParts> {
  const out: BuiltParts = { images: [], fromDisplay: [], missing: [] };
  const texts: string[] = [];
  for (const f of files) {
    if (f.mime === 'application/pdf') {
      const text = mode === 'receipt' ? await deps.textOf(f.fileId) : null;
      if (text?.trim()) texts.push(text.trim());
      else out.missing.push(f.attachmentId);
      continue;
    }
    if (!f.mime.startsWith('image/')) {
      out.missing.push(f.attachmentId);
      continue;
    }
    let img: ImageInput | null = null;
    let fromDisplay = false;
    if (mode === 'thing') {
      img = await display(deps.blobs, f);
      fromDisplay = img !== null;
      if (!img) {
        const original = await blob(deps.blobs, originalKey(f.locationId, f.fileId));
        img = original ? await reencode(original, THING_MAX_PX, f.attachmentId) : null;
      }
    } else {
      const original = await blob(deps.blobs, originalKey(f.locationId, f.fileId));
      img = original ? await reencode(original, EVIDENCE_MAX_PX, f.attachmentId) : null;
      if (!img) {
        img = await display(deps.blobs, f);
        fromDisplay = img !== null;
      }
    }
    if (img) {
      out.images.push(img);
      out.fromDisplay.push(fromDisplay);
    } else out.missing.push(f.attachmentId);
  }
  if (texts.length > 0) out.documentText = texts.join('\n\n');
  return out;
}
