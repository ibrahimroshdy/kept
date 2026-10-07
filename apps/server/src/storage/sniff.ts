import { fileTypeFromFile } from 'file-type';
import { AppError } from '../http/errors.js';

// What an upload really is (D157): read from its first bytes (file-type's magic numbers), never
// from the declared Content-Type or the file's name. Anything not on the allow-list is 415
// `unsupported_media_type`, including:
// - SVG (Q9): it is text and can carry script; no logo uploads until step 4 rasterises them;
// - HTML or anything else renamed to `.jpg`;
// - HEIF/HEIC *sequences* (bursts, animations): only still images are photos here.
// Videos (MP4, QuickTime) pass only with `allowVideo`, for the 1.x videos of D170.

export type SniffedKind = 'image' | 'pdf' | 'video';

export type Sniffed = {
  mime: string;
  /** file-type's extension for the content (`jpg`, `heic`, `pdf`, …). */
  ext: string;
  kind: SniffedKind;
};

const ALLOWED: Readonly<Record<string, SniffedKind>> = Object.freeze({
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'image/avif': 'image',
  'image/gif': 'image',
  'application/pdf': 'pdf',
  'video/mp4': 'video',
  'video/quicktime': 'video',
});

export type SniffOptions = {
  /** D170: accept MP4 and QuickTime. Off in step 2. */
  allowVideo?: boolean;
};

/** Every MIME type sniff() can accept (with the video flag). */
export const SNIFF_ALLOWED_MIMES: readonly string[] = Object.freeze(Object.keys(ALLOWED));

function refused(): AppError {
  return new AppError(
    'unsupported_media_type',
    415,
    'Add a photo (JPEG, PNG, WebP, HEIC, AVIF or GIF) or a PDF.',
  );
}

/** The sniffed type of the file at `filePath`, or 415 when it isn't allowed. */
export async function sniff(filePath: string, opts: SniffOptions = {}): Promise<Sniffed> {
  const found = await fileTypeFromFile(filePath);
  if (!found) throw refused();
  const kind = ALLOWED[found.mime];
  if (!kind || (kind === 'video' && !opts.allowVideo)) throw refused();
  return { mime: found.mime, ext: found.ext, kind };
}
