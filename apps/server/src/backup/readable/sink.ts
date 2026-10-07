import { createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ReadableFile } from '../../exports/readable/index.js';
import { assertBlobKey, BlobNotFoundError, type BlobStore } from '../../storage/blob-store.js';
import { LocalBlobStore } from '../../storage/local.js';

// Where a location's readable copy finds the originals its pages link to (step-8 plan T6, Q11).
// The builder (exports/readable/) only links; this puts each file at `<dir>/<href>`:
//   - local file storage: a hard link to the blob itself, so the copy takes no extra space and
//     restic stores the bytes once (it reads both paths, and deduplicates by content). A link
//     that can't be made (another filesystem) falls back to a copy;
//   - S3 file storage: a download, receipts and documents as their originals and photos as their
//     display rendition (the builder already named that one). A file the previous tree already
//     held is hard-linked from it, not fetched again.
// A blob that isn't in the store (a purge racing the run) is skipped and counted: its page links
// to nothing, the rest of the copy stands.

const CONCURRENCY = 4;

export type PlacedFiles = { placed: number; reused: number; fetched: number; missing: number };

export type SinkOptions = {
  storage: 'local' | 's3';
  blobs: BlobStore;
  /** The location's previous tree, when it is being rewritten: files to reuse by name. */
  previousDir?: string | null;
  log?: { error: (obj: object, msg: string) => void };
};

/** The path of a local blob, or null when the store isn't local. */
function localPathOf(blobs: BlobStore, key: string): string | null {
  if (!(blobs instanceof LocalBlobStore)) return null;
  const full = path.resolve(blobs.root, assertBlobKey(key));
  if (!full.startsWith(`${blobs.root}${path.sep}`)) return null;
  return full;
}

/** An href the builder wrote (`files/<id>.<ext>`): relative, inside `dir`, never `..`. */
function targetOf(dir: string, href: string): string {
  const full = path.resolve(dir, href);
  if (!full.startsWith(`${path.resolve(dir)}${path.sep}`)) {
    throw new Error('a readable file escapes its directory');
  }
  return full;
}

const exists = (file: string) =>
  stat(file).then(
    (s) => s.isFile(),
    () => false,
  );

/** Places every file at `<dir>/<href>`. */
export async function placeFiles(
  dir: string,
  files: readonly ReadableFile[],
  opts: SinkOptions,
): Promise<PlacedFiles> {
  const out: PlacedFiles = { placed: 0, reused: 0, fetched: 0, missing: 0 };
  let next = 0;
  const one = async (f: ReadableFile) => {
    const dest = targetOf(dir, f.href);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (opts.storage === 'local') {
      const source = localPathOf(opts.blobs, f.storageKey);
      if (source) {
        try {
          await link(source, dest);
          out.placed += 1;
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            out.missing += 1;
            return;
          }
          if (code === 'EEXIST') {
            out.placed += 1;
            return;
          }
          if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK') throw err;
          await copyFile(source, dest);
          out.placed += 1;
          return;
        }
      }
    }
    // S3 (or a store with no local path): the previous tree's copy, else a download.
    if (opts.previousDir) {
      const before = targetOf(opts.previousDir, f.href);
      if (await exists(before)) {
        await link(before, dest).catch(async () => copyFile(before, dest));
        out.placed += 1;
        out.reused += 1;
        return;
      }
    }
    const partial = `${dest}.partial`;
    try {
      await pipeline(
        await opts.blobs.stream(f.storageKey),
        createWriteStream(partial, { mode: 0o600 }),
      );
      await rename(partial, dest);
      out.placed += 1;
      out.fetched += 1;
    } catch (err) {
      await rm(partial, { force: true });
      if (err instanceof BlobNotFoundError || (err as Error).name === 'BlobNotFoundError') {
        out.missing += 1;
        opts.log?.error({ fileId: f.id }, 'readable copy: a file is not in the store');
        return;
      }
      throw err;
    }
  };
  const worker = async () => {
    while (next < files.length) await one(files[next++] as ReadableFile);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return out;
}
