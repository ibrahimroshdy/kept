import { rm } from 'node:fs/promises';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope } from '../db/scope.js';
import { AppError, pgErrorOf } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { derivativeKey, type FileStorage, originalKey } from '../storage/blob-store.js';
import {
  type Derived,
  derivativeTempPaths,
  derive,
  ImageBusyError,
  type ImageLimiter,
} from '../storage/derivatives.js';
import { type Sniffed, sniff } from '../storage/sniff.js';
import { deleteUnreferencedBlobs } from './attachments.js';
import { lockBlobKeys } from './blob-locks.js';
import {
  derivativeKeys,
  FILE_COLUMNS,
  type FileClass,
  type FileRow,
  type FileView,
  fileViewOf,
} from './views.js';

// The one way a file's bytes become a Kept file (step-7 plan T2): the upload route
// (files/upload.ts) and both archive importers (imports/homebox, imports/kept) call it, so an
// imported photo is sniffed, deduplicated, resized and stored exactly as an uploaded one is.
// Extracted from upload() without a change in behaviour; the caller has already received the
// bytes into a local temp file it owns (and removes), hashed and counted them, and checked who
// may add files. In order (upload.ts's steps 4–8):
// - the content must sniff as an allowed type (415 `unsupported_media_type`, D157);
// - a replay of the same id with the same bytes answers the file again (200); the same id with
//   other bytes is 409 `idempotency_mismatch`; the same bytes already in the location answer the
//   existing file with `deduplicatedFrom` (200, D177: per location, never across);
// - derivatives, bounded by KEPT_IMAGE_CONCURRENCY; a full queue is 503 with Retry-After;
// - the blobs first, with no transaction open (security review #16), under the keys the database
//   will stamp;
// - one short transaction under the keys' advisory locks: the file row, each derivative row, the
//   audit event (`file.upload`, or `file.import` for an importer; no content, no name), and for a
//   PDF the `pdf-text` job. A failure deletes the blobs no row names.

/** Seconds a refused upload is told to wait (Retry-After). */
export const UPLOAD_RETRY_AFTER = 5;

/** 503 while the image queue is full (review #15); the route adds Retry-After. */
export const imagesBusy = () =>
  new AppError('internal', 503, 'Kept is busy resizing other photos. Try again in a few seconds.', {
    retryAfter: UPLOAD_RETRY_AFTER,
  });

export type IngestDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage;
  limiter: ImageLimiter;
  log: { error: (obj: object, msg: string) => void };
  /** Where a PDF's `pdf-text` job is sent (T21); absent or null: no text is read (tests). */
  jobs?: JobQueue | null;
};

export type IngestInput = {
  /** A local temp file the caller owns: received, hashed and counted, and removed by the caller. */
  file: string;
  sha256: string;
  bytes: number;
  /** A client UUIDv7 for an upload; a new UUIDv7 for an imported file (never an archive's id). */
  fileId: string;
  locationId: string;
  class: FileClass;
};

export type IngestOptions = {
  /** `file.upload` by default; the importers pass `file.import`. */
  auditAction?: 'file.upload' | 'file.import';
  /** The request's id for the audit row; a job has none. */
  requestId?: string | null;
};

export type UploadResult = { status: 200 | 201; body: FileView };

/** The file with this id, or with these bytes in this location, as the caller sees it. */
async function existing(
  client: pg.ClientBase,
  input: IngestInput,
): Promise<{ byId: FileRow | undefined; bySha: FileRow | undefined }> {
  const { rows } = await client.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM public.files f
      WHERE f.id = $1 OR (f.location_id = $2 AND f.sha256 = $3)`,
    [input.fileId, input.locationId, input.sha256],
  );
  return {
    byId: rows.find((r) => r.id === input.fileId),
    bySha: rows.find((r) => r.location_id === input.locationId && r.sha256 === input.sha256),
  };
}

/** A replay or a dedupe hit answered from what is already stored; null when the file is new. */
async function answered(
  client: pg.ClientBase,
  files: FileStorage,
  input: IngestInput,
): Promise<UploadResult | null> {
  const { byId, bySha } = await existing(client, input);
  if (byId) {
    if (byId.sha256 !== input.sha256 || byId.location_id !== input.locationId) {
      throw new AppError(
        'idempotency_mismatch',
        409,
        'That file id was used for other bytes. Upload with a new id.',
      );
    }
    return {
      status: 200,
      body: await fileViewOf(files, byId, await derivativeKeys(client, [byId.id])),
    };
  }
  if (bySha) {
    const view = await fileViewOf(files, bySha, await derivativeKeys(client, [bySha.id]));
    return { status: 200, body: { ...view, deduplicatedFrom: bySha.id } };
  }
  return null;
}

/** Sniffs, deduplicates, resizes and stores one received file, and records it in the caller's
 * scope. The caller removes `input.file`; the derivative temp files made here are removed here. */
export async function ingestFile(
  deps: IngestDeps,
  scope: Scope,
  input: IngestInput,
  opts: IngestOptions = {},
): Promise<UploadResult> {
  const { pools, files, limiter, log } = deps;
  const stored: string[] = [];
  try {
    const sniffed: Sniffed = await sniff(input.file);

    const early = await withScope(pools.app, scope, (_tx, client) =>
      answered(client, files, input),
    );
    if (early) return early;

    let derived: Derived;
    try {
      derived = await limiter.run(() => derive(input.file, sniffed));
    } catch (err) {
      if (err instanceof ImageBusyError) throw imagesBusy();
      throw err;
    }

    // The blobs first, outside any transaction (review #16), under the keys the rows will get.
    const original = originalKey(input.locationId, input.fileId);
    const blobs = [
      { key: original, file: input.file, contentType: sniffed.mime, bytes: input.bytes },
      ...derived.variants.map((v) => ({
        key: derivativeKey(input.fileId, v.variant),
        file: v.path,
        contentType: 'image/jpeg',
        bytes: v.bytes,
      })),
    ];
    const putAll = async () => {
      for (const b of blobs) {
        if (!stored.includes(b.key)) stored.push(b.key);
        await files.blobs.put(b.key, b.file, { contentType: b.contentType, bytes: b.bytes });
      }
    };
    try {
      await putAll();
      return await withScope(pools.app, scope, async (tx, client) => {
        await lockBlobKeys(client, stored);
        // A failed upload of the same id may have cleaned up between our puts and this lock; its
        // clean-up deletes every key under the lock, the original first stored, so checking the
        // original is enough.
        if (!(await files.blobs.exists(original))) await putAll();
        const { rows } = await client.query<FileRow>(
          `INSERT INTO public.files AS f (id, location_id, storage_key, sha256, bytes, mime, class,
                                          has_gps, width, height, derivative_state, created_by)
           VALUES ($1, $2, '-', $3, $4, $5, $6, $7, $8, $9, $10, kept.current_user_id())
           RETURNING ${FILE_COLUMNS}`,
          [
            input.fileId,
            input.locationId,
            input.sha256,
            input.bytes,
            sniffed.mime,
            input.class,
            derived.hasGps,
            derived.width,
            derived.height,
            derived.state,
          ],
        );
        const row = rows[0] as FileRow;
        // The database stamps the key (0024); it is the one the blob went under, or nothing names it.
        if (row.storage_key !== original) throw new Error('upload: unexpected original key');
        for (const v of derived.variants) {
          const { rows: made } = await client.query<{ storage_key: string }>(
            `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key,
                                                  width, height, bytes)
             VALUES ($1, $2, $3, '-', $4, $5, $6) RETURNING storage_key`,
            [row.id, v.variant, row.location_id, v.width, v.height, v.bytes],
          );
          const key = (made[0] as { storage_key: string }).storage_key;
          if (key !== derivativeKey(row.id, v.variant)) {
            throw new Error('upload: unexpected derivative key');
          }
        }
        await audited(tx, {
          locationId: row.location_id,
          actor: { type: 'user', id: scope.userId },
          action: opts.auditAction ?? 'file.upload',
          entity: { type: 'file', id: row.id },
          after: {
            class: row.class,
            mime: row.mime,
            bytes: Number(row.bytes),
            hasGps: row.has_gps,
            derivativeState: row.derivative_state,
          },
          requestId: opts.requestId ?? null,
        });
        // A PDF's text layer, read for search and receipts in a limited child process (T21).
        if (row.mime === 'application/pdf') {
          await deps.jobs?.sendTenant(client, 'pdf-text', { fileId: row.id });
        }
        const view = await fileViewOf(files, row, await derivativeKeys(client, [row.id]));
        return { status: 201 as const, body: view };
      });
    } catch (err) {
      // Only what no row names: a racing upload of the same id may have committed these keys.
      await deleteUnreferencedBlobs(pools, files, stored, log).catch((e: unknown) => {
        log.error({ err: e }, 'upload: its blobs could not be cleaned up');
      });
      stored.length = 0;
      // Someone stored the same bytes in this location a moment ago: answer theirs (D177).
      if (pgErrorOf(err)?.constraint === 'files_location_sha_uq') {
        const late = await withScope(pools.app, scope, (_tx, client) =>
          answered(client, files, input),
        );
        if (late) return late;
        // The same bytes are here as another member's upload that isn't attached yet, which
        // this caller can't see (§7.2): nothing to answer with, and nothing to reveal.
        throw new AppError(
          'conflict',
          409,
          'The same file is being added by someone else. Try again once it is attached.',
        );
      }
      throw err;
    }
  } finally {
    await Promise.all(derivativeTempPaths(input.file).map((t) => rm(t, { force: true })));
  }
}
