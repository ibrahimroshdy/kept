import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { PassThrough, type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

// The one archive writer (plan T7; spike Z1): an export, or anything else Kept hands out as a
// ZIP, streamed through yazl to a temp file the caller owns (KEPT_DATA_DIR/tmp), and then
// `put()` into the BlobStore by the caller. The spike wrote 2 GiB in 29 MiB of RSS and 4.1 GiB
// (ZIP64) in 41 MiB this way.
//
// - Names are the caller's fixed ones (`manifest.json`, `data/things.ndjson`,
//   `attachments/<uuid>`); yazl refuses an absolute path or `..` itself.
// - Files that are already compressed (photos, PDFs) are stored; text (JSON, CSV, HTML) is
//   deflated. A caller that knows better passes `compress`.
// - Every entry has the same fixed mtime and mode 0600, so two exports of the same data are the
//   same bytes, and an unzipped export is readable by its owner only.

/** Every entry's modification time: fixed, so the archive depends on its contents alone. */
export const ARCHIVE_MTIME = new Date(Date.UTC(2026, 0, 1));
/** A regular file, owner read and write (yazl's `mode` carries the file type bits). */
export const ARCHIVE_MODE = 0o100600;

/** Content types stored as they are: deflating them costs time and saves nothing. */
const STORED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/gif',
  'application/pdf',
  'application/zip',
]);
const STORED_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|avif|gif|pdf|zip)$/i;

/** Whether an entry is deflated: by its content type when given, else by its name. */
export function shouldCompress(name: string, contentType?: string): boolean {
  if (contentType) return !STORED_TYPES.has(contentType.split(';')[0]?.trim().toLowerCase() ?? '');
  return !STORED_EXTENSIONS.test(name);
}

export type EntryOptions = {
  /** The file's sniffed type, which decides stored or deflated. */
  contentType?: string;
  /** Overrides the choice. */
  compress?: boolean;
  /** The exact size, when known (a stored entry then needs no data descriptor pass). */
  size?: number;
};

export type ArchiveBuilder = {
  /** A buffer (JSON, CSV, HTML). */
  addBuffer(name: string, data: Buffer | string, opts?: EntryOptions): void;
  /** A stream opened only when the writer reaches the entry, so a thousand photos don't hold a
   * thousand open handles. */
  addStream(name: string, open: () => Promise<Readable> | Readable, opts?: EntryOptions): void;
};

export type WrittenArchive = { bytes: number; sha256: string };

/**
 * Writes the archive `build` describes to `file` and returns its size and SHA-256. On any error
 * the partial file is removed and the error rethrown.
 */
export async function writeArchive(
  file: string,
  build: (zip: ArchiveBuilder) => Promise<void> | void,
): Promise<WrittenArchive> {
  const zip = new yazl.ZipFile();
  const hash = createHash('sha256');
  let bytes = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  // yazl reports a failed source stream as an `error` on the ZipFile, not on outputStream.
  const failed = new Promise<never>((_resolve, reject) => zip.on('error', reject));
  failed.catch(() => {});
  const output = zip.outputStream as unknown as Readable;
  zip.on('error', (err: Error) => output.destroy?.(err));
  const written = pipeline(output, measure, createWriteStream(file, { mode: 0o600 }));
  written.catch(() => {});

  const entry = (name: string, opts: EntryOptions = {}) => ({
    compress: opts.compress ?? shouldCompress(name, opts.contentType),
    mtime: ARCHIVE_MTIME,
    mode: ARCHIVE_MODE,
    ...(opts.size === undefined ? {} : { size: opts.size }),
  });

  const builder: ArchiveBuilder = {
    addBuffer(name, data, opts) {
      zip.addBuffer(
        typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
        name,
        entry(name, opts),
      );
    },
    addStream(name, open, opts) {
      zip.addReadStreamLazy(name, entry(name, opts), (cb) => {
        Promise.resolve()
          .then(open)
          .then(
            (stream) => {
              // A PassThrough, so an error on the source reaches yazl as a stream error.
              const through = new PassThrough();
              stream.on('error', (err) => through.destroy(err));
              cb(null, stream.pipe(through));
            },
            (err: unknown) => cb(err, undefined as unknown as NodeJS.ReadableStream),
          );
      });
    },
  };

  try {
    await build(builder);
    zip.end();
    await Promise.race([written, failed]);
  } catch (err) {
    output.destroy?.();
    await rm(file, { force: true });
    throw err;
  }
  return { bytes, sha256: hash.digest('hex') };
}
