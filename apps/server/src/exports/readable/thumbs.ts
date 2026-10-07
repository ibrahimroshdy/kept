import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileStorage } from '../../storage/blob-store.js';

// The readable copy's thumbnails (plan T13): each thing's first photo, as its 400 px thumbnail
// derivative (storage/derivatives.ts), copied byte for byte to `thumbs/<fileId>.jpg`. The name is
// the file's id, never anything a person typed. A missing derivative (an image still being
// processed) leaves the thing without a thumbnail; the copy doesn't fail for it.

const CONCURRENCY = 4;

export type ThumbJob = { fileId: string; key: string };

/** Copies each thumbnail; returns the file ids written. */
export async function copyThumbs(
  files: FileStorage,
  dir: string,
  jobs: readonly ThumbJob[],
  log: { error: (obj: object, msg: string) => void },
): Promise<Set<string>> {
  const done = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++] as ThumbJob;
      try {
        await pipeline(
          await files.blobs.stream(job.key),
          createWriteStream(path.join(dir, `${job.fileId}.jpg`), { mode: 0o600 }),
        );
        done.add(job.fileId);
      } catch (err) {
        log.error({ err, fileId: job.fileId }, 'readable copy: a thumbnail could not be read');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return done;
}
