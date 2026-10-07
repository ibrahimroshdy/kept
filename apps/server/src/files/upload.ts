import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { requireScope } from '../auth/http.js';
import { withScope } from '../db/scope.js';
import { AppError, invalid } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { derivativeTempPaths } from '../storage/derivatives.js';
import {
  type IngestDeps,
  imagesBusy,
  ingestFile,
  UPLOAD_RETRY_AFTER,
  type UploadResult,
} from './ingest.js';
import type { FileClass } from './views.js';

export { imagesBusy, UPLOAD_RETRY_AFTER, type UploadResult } from './ingest.js';

// PUT /api/v1/files/:fileId?locationId=&class= (plan T17; D36, D117, D157, D177; §3.4).
//
// The body is the file itself, raw (no multipart, which is step 3's share-in). In order:
// 1. who: a member or above in the location (`attachments.add`), and a client UUIDv7 id;
// 2. how big: Content-Length is required, and over KEPT_MAX_FILE_MB is 413 before a byte is
//    read (the content-type parser refuses it); the stream is counted too, and cut at the limit;
// 3. streamed to KEPT_DATA_DIR/tmp while hashed (SHA-256) and counted: never held in memory;
// 4. the hash must equal X-Kept-Sha256 (400 `checksum_mismatch`), and the content must sniff as
//    an allowed type (415 `unsupported_media_type`), whatever the declared type or name;
// 5. a replay of the same id with the same bytes answers the file again (200); the same id with
//    other bytes is 409 `idempotency_mismatch`; the same bytes already in the location answer the
//    existing file with `deduplicatedFrom` (200, D177: dedupe per location, never across);
// 6. derivatives, bounded by KEPT_IMAGE_CONCURRENCY (storage/derivatives.ts); a full queue is
//    503 with Retry-After (security review #15);
// 7. the blobs are stored first, with no transaction open (a slow S3 put holds no row locks;
//    security review #16): the original untouched (D117) and each derivative, under the keys the
//    database will stamp (the same id-built keys, checked again on insert);
// 8. one short transaction: under the keys' advisory locks (blob-locks.ts), a check that the
//    original is still there (a failed upload's clean-up may have removed it: then everything is
//    stored again), the file row, each derivative row, and the `file.upload` audit event (no
//    content, no name), and for a PDF the `pdf-text` job (files/pdf-text.ts, T21), so the job
//    exists only if the file does. A failure deletes the blobs no row names
//    (deleteUnreferencedBlobs), so a racing upload of the same id keeps what it stored.
// The route allows a person three uploads at a time (UploadSlots; 429 with Retry-After).
//
// Idempotency-Key is not used here: the file id is the upload's replay key (D36), and the body
// is a stream, not JSON to hash.
//
// Steps 4 (the sniff) to 8 are ingestFile() (files/ingest.ts, step-7 plan T2), which the archive
// importers call too; this file keeps the request's part: headers, the size, the checksum, the
// upload slots.

const SHA256 = /^[0-9a-f]{64}$/;

/** Headers of an upload, as the content-type parser and the handler read them. */
function header(req: Pick<FastifyRequest, 'headers'>, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

export const payloadTooLarge = (maxBytes: number) =>
  new AppError(
    'payload_too_large',
    413,
    `Files can be up to ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
  );

/** The declared size, checked before the body is read: 411 without one, 413 over the limit. */
export function declaredLength(req: Pick<FastifyRequest, 'headers'>, maxBytes: number): number {
  const raw = header(req, 'content-length');
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) {
    throw new AppError('validation', 411, 'Send the file with a Content-Length.');
  }
  const bytes = Number(raw);
  if (bytes > maxBytes) throw payloadTooLarge(maxBytes);
  if (bytes === 0) throw invalid('The file is empty.');
  return bytes;
}

export type Received = { file: string; sha256: string; bytes: number };

/** Streams `body` to a new file in `dir`, hashing and counting; cut at `maxBytes`. Also the phone
 * display's upload (capture/display.ts). */
export async function receive(body: Readable, dir: string, maxBytes: number): Promise<Received> {
  await mkdir(dir, { recursive: true, mode: 0o750 });
  const file = path.join(dir, randomUUID());
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done(payloadTooLarge(maxBytes));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(file, { mode: 0o640 }));
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
  return { file, sha256: hash.digest('hex'), bytes };
}

export type UploadInput = {
  fileId: string;
  locationId: string;
  class: FileClass;
};

export type UploadDeps = IngestDeps;

/** At most `max` uploads in flight per person (security review #16): on a Pi, three large
 * uploads already fill the temp disk and the image queue for everyone else. In-process: one
 * server process serves uploads. */
export class UploadSlots {
  readonly #busy = new Map<string, number>();
  constructor(readonly max = 3) {}

  /** A release function, or null when the person already has `max` uploads going. */
  take(userId: string): (() => void) | null {
    const n = this.#busy.get(userId) ?? 0;
    if (n >= this.max) return null;
    this.#busy.set(userId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#busy.get(userId) ?? 1) - 1;
      if (left <= 0) this.#busy.delete(userId);
      else this.#busy.set(userId, left);
    };
  }
}

/** 429 while a person has their three uploads going; the route adds Retry-After. */
export const tooManyUploads = () =>
  new AppError('rate_limited', 429, 'Wait for your other uploads to finish, then try again.', {
    retryAfter: UPLOAD_RETRY_AFTER,
  });

/** The whole upload; `body` is the request's raw stream. */
export async function upload(
  deps: UploadDeps,
  req: FastifyRequest,
  body: Readable,
  input: UploadInput,
): Promise<UploadResult> {
  const scope = requireScope(req);
  const { pools, files, limiter } = deps;
  const declaredSha = header(req, 'x-kept-sha256')?.toLowerCase();
  if (!declaredSha || !SHA256.test(declaredSha)) {
    throw invalid('Send X-Kept-Sha256: the SHA-256 of the file, in hex.');
  }
  declaredLength(req, files.maxFileBytes);

  // Who, before a byte is stored: 404 for a location the caller can't see, 403 for a viewer.
  await withScope(pools.app, scope, async (_tx, client) => {
    const me = await requireMembership(client, input.locationId);
    requireCan(me.role, 'attachments.add', 'Viewers can look at files but not add them.');
  });

  // Refused before the body is spooled, when the image queue is already full.
  if (limiter.full) throw imagesBusy();
  const received = await receive(body, files.tmpDir, files.maxFileBytes);
  const temps = [received.file, ...derivativeTempPaths(received.file)];
  try {
    if (received.sha256 !== declaredSha) {
      throw new AppError(
        'checksum_mismatch',
        400,
        "The bytes that arrived don't match X-Kept-Sha256. Upload the file again.",
      );
    }
    return await ingestFile(
      deps,
      scope,
      {
        file: received.file,
        sha256: received.sha256,
        bytes: received.bytes,
        fileId: input.fileId,
        locationId: input.locationId,
        class: input.class,
      },
      { requestId: req.id },
    );
  } finally {
    await Promise.all(temps.map((t) => rm(t, { force: true })));
  }
}
