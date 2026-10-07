import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type pg from 'pg';
import { blobToFile } from '../backup/manifest.js';
import { BlobNotFoundError, type BlobStore, isBlobKey } from './blob-store.js';

// Switching file storage between local and S3 (D186; step-8 plan T13): `kept admin storage copy
// --to s3|local` and `kept admin storage verify --store s3|local` (cli/storage.ts).
//
// What is copied is what the database references: every original (`files`, with the SHA-256 the
// upload checked), every derivative (`file_derivatives`, whose bytes the row records), and every
// export ZIP still downloadable (`export_runs`, with its archive's SHA-256 when it has one).
// Reports (`r/`, a day) and import archives (`i/`, read while the import runs) are short-lived
// and made again on request, so they are not carried over.
//
// Each blob goes source → a temp file (hashed on the way) → destination → read back and hashed
// again. A blob already at the destination with the right hash is skipped, so a copy can be run
// again and again (resumable), and a destination object with the wrong bytes is copied over.
// Blobs are immutable and keyed by ids, so copying while Kept runs is safe; a second run after
// Kept stops picks up what arrived in between. The source is never changed or deleted.

export type CopyEntry = {
  key: string;
  /** Known for originals and most export ZIPs; null for derivatives. */
  sha256: string | null;
  bytes: number | null;
  contentType: string;
};

/** Every blob the rows reference, once per key (copies share a key, D161), in key order. */
export async function blobsToCopy(client: pg.ClientBase): Promise<CopyEntry[]> {
  const { rows } = await client.query<{
    key: string;
    sha256: string | null;
    bytes: string | null;
    content_type: string;
  }>(
    `SELECT storage_key AS key, min(sha256) AS sha256, max(bytes)::text AS bytes,
            min(mime) AS content_type
       FROM public.files GROUP BY storage_key
     UNION ALL
     SELECT storage_key, NULL, max(bytes)::text, 'image/jpeg'
       FROM public.file_derivatives GROUP BY storage_key
     UNION ALL
     SELECT storage_key, min(sha256), max(bytes)::text, 'application/zip'
       FROM public.export_runs
      WHERE storage_key IS NOT NULL AND expires_at > now()
      GROUP BY storage_key
     ORDER BY 1`,
  );
  return rows.map((r) => ({
    key: r.key,
    sha256: r.sha256 && /^[0-9a-f]{64}$/.test(r.sha256) ? r.sha256 : null,
    bytes: r.bytes === null ? null : Number(r.bytes),
    contentType: r.content_type,
  }));
}

/** SHA-256 and size of a stream. */
async function hashStream(stream: Readable): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** The blob's hash, or null when the store doesn't have it. */
async function hashBlob(
  store: BlobStore,
  key: string,
): Promise<{ sha256: string; bytes: number } | null> {
  try {
    return await hashStream(await store.stream(key));
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

/** Whether a blob's bytes are the ones the row records. */
function matches(
  entry: CopyEntry,
  got: { sha256: string; bytes: number },
  sourceSha: string | null,
): boolean {
  if (entry.bytes !== null && got.bytes !== entry.bytes) return false;
  if (entry.sha256 !== null) return got.sha256 === entry.sha256;
  return sourceSha !== null && got.sha256 === sourceSha;
}

export type CopyProblem = {
  key: string;
  /** `missing`: the source has no such blob. `source_mismatch`: the source's bytes aren't the
   * ones the row records (left alone, not copied). `verify_failed`: the destination read back
   * differently. `failed`: the store refused (the message is the error's name, no key). */
  reason: 'missing' | 'source_mismatch' | 'verify_failed' | 'failed';
};

export type CopyReport = {
  total: number;
  /** Copied now (or, with dryRun, would be). */
  copied: number;
  /** Already at the destination with the right bytes. */
  present: number;
  /** At the destination with the wrong bytes, so copied over (counted in `copied` too). */
  replaced: number;
  bytesCopied: number;
  problems: CopyProblem[];
};

export type CopyOptions = {
  from: BlobStore;
  to: BlobStore;
  entries: readonly CopyEntry[];
  /** Where each blob waits between the stores (KEPT_DATA_DIR/tmp). */
  tmpDir: string;
  dryRun?: boolean;
  /** Blobs in flight at once. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

async function copyOne(entry: CopyEntry, opts: CopyOptions, report: CopyReport): Promise<void> {
  const { from, to } = opts;
  if (!isBlobKey(entry.key)) {
    // A row holds a key no store accepts: say so, never build a path from it.
    report.problems.push({ key: entry.key, reason: 'failed' });
    return;
  }
  // Derivatives carry no hash: the source's is the reference.
  const source = entry.sha256 === null ? await hashBlob(from, entry.key) : null;
  if (entry.sha256 === null && source === null) {
    report.problems.push({ key: entry.key, reason: 'missing' });
    return;
  }
  const there = await hashBlob(to, entry.key);
  if (there && matches(entry, there, source?.sha256 ?? null)) {
    report.present += 1;
    return;
  }
  if (opts.dryRun) {
    report.copied += 1;
    if (there) report.replaced += 1;
    return;
  }
  const tmp = path.join(opts.tmpDir, `storage-copy-${randomUUID()}`);
  try {
    let got: { sha256: string; bytes: number };
    try {
      got = await blobToFile(from, entry.key, tmp);
    } catch (err) {
      if (err instanceof BlobNotFoundError) {
        report.problems.push({ key: entry.key, reason: 'missing' });
        return;
      }
      throw err;
    }
    if (!matches(entry, got, source?.sha256 ?? null)) {
      report.problems.push({ key: entry.key, reason: 'source_mismatch' });
      return;
    }
    await to.put(entry.key, tmp, { contentType: entry.contentType, bytes: got.bytes });
    const back = await hashBlob(to, entry.key);
    if (!back || back.sha256 !== got.sha256 || back.bytes !== got.bytes) {
      report.problems.push({ key: entry.key, reason: 'verify_failed' });
      return;
    }
    report.copied += 1;
    report.bytesCopied += got.bytes;
    if (there) report.replaced += 1;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Copies every entry from one store to the other, verified; see the header. */
export async function copyBlobs(opts: CopyOptions): Promise<CopyReport> {
  const report: CopyReport = {
    total: opts.entries.length,
    copied: 0,
    present: 0,
    replaced: 0,
    bytesCopied: 0,
    problems: [],
  };
  await mkdir(opts.tmpDir, { recursive: true, mode: 0o700 });
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const entry = opts.entries[i];
      if (!entry) return;
      try {
        await copyOne(entry, opts, report);
      } catch {
        report.problems.push({ key: entry.key, reason: 'failed' });
      }
      done += 1;
      opts.onProgress?.(done, report.total);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 4, 16));
  await Promise.all(Array.from({ length: n }, worker));
  report.problems.sort((a, b) => a.key.localeCompare(b.key));
  return report;
}

export type VerifyProblem = {
  key: string;
  /** `missing`: not in the store. `mismatch`: other bytes than the row records. `failed`: the
   * store refused. */
  reason: 'missing' | 'mismatch' | 'failed';
};

export type VerifyReport = { total: number; ok: number; problems: VerifyProblem[] };

/**
 * Reads every referenced blob in a store and checks it against its row: the SHA-256 where the
 * row has one, else the byte count (a derivative has no recorded hash).
 */
export async function verifyBlobs(opts: {
  store: BlobStore;
  entries: readonly CopyEntry[];
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<VerifyReport> {
  const report: VerifyReport = { total: opts.entries.length, ok: 0, problems: [] };
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const entry = opts.entries[i];
      if (!entry) return;
      try {
        if (!isBlobKey(entry.key)) {
          report.problems.push({ key: entry.key, reason: 'failed' });
        } else {
          const got = await hashBlob(opts.store, entry.key);
          if (!got) report.problems.push({ key: entry.key, reason: 'missing' });
          else if (
            (entry.bytes !== null && got.bytes !== entry.bytes) ||
            (entry.sha256 !== null && got.sha256 !== entry.sha256)
          ) {
            report.problems.push({ key: entry.key, reason: 'mismatch' });
          } else report.ok += 1;
        }
      } catch {
        report.problems.push({ key: entry.key, reason: 'failed' });
      }
      done += 1;
      opts.onProgress?.(done, report.total);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 4, 16));
  await Promise.all(Array.from({ length: n }, worker));
  report.problems.sort((a, b) => a.key.localeCompare(b.key));
  return report;
}
