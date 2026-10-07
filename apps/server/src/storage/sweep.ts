import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// Boot-time clean-up of what a crash leaves on disk (security review #16):
// - KEPT_DATA_DIR/tmp: an upload's spooled body and its derivative temp files (files/upload.ts)
//   are removed when the request ends, but not when the process dies mid-upload;
// - KEPT_DATA_DIR/blobs/**/<name>.<uuid>.tmp: the local store writes a blob under a temp name and
//   renames it into place (storage/local.ts), so a crash mid-put leaves the temp file.
// Only files older than an hour go: nothing still being written is that old (an upload is at
// most KEPT_MAX_FILE_MB, and the request would have timed out long before).

export const STALE_AFTER_MS = 60 * 60 * 1000;

/** A local store's in-flight write: `<key's last segment>.<uuid>.tmp`. */
const BLOB_TEMP = /\.[0-9a-f-]{8,}\.tmp$/i;

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function removeIfStale(file: string, before: number): Promise<number> {
  try {
    const { mtimeMs } = await stat(file);
    if (mtimeMs >= before) return 0;
    await rm(file, { force: true });
    return 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function sweepBlobTemps(dir: string, before: number): Promise<number> {
  let removed = 0;
  for (const e of await entries(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) removed += await sweepBlobTemps(full, before);
    else if (e.isFile() && BLOB_TEMP.test(e.name)) removed += await removeIfStale(full, before);
  }
  return removed;
}

/**
 * Removes stale files from the upload temp directory (every file there is a temp file) and stale
 * `.tmp` files under the local blob root (`null` on S3, where a failed put leaves nothing).
 * Returns how many files went.
 */
export async function sweepStaleTemps(
  dirs: { tmpDir: string; blobsRoot: string | null },
  olderThanMs = STALE_AFTER_MS,
  now = Date.now(),
): Promise<number> {
  const before = now - olderThanMs;
  let removed = 0;
  for (const e of await entries(dirs.tmpDir)) {
    if (e.isFile()) removed += await removeIfStale(path.join(dirs.tmpDir, e.name), before);
  }
  if (dirs.blobsRoot) removed += await sweepBlobTemps(dirs.blobsRoot, before);
  return removed;
}
