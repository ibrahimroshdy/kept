import type { Readable } from 'node:stream';
import type { UrlSigner } from './signed-url.js';

// Where file bytes live (engineering spec §7.2; D117, D157, Q16, Q18). One interface, two
// drivers: local.ts (KEPT_DATA_DIR/blobs) and s3.ts (T18). Originals are kept byte-identical;
// derivatives are the GPS-stripped, rotated renditions made from them.
//
// Keys are built only from ids, never from anything a user named (D157):
// - `f/<locationId>/<fileId>` for an original;
// - `d/<fileId>/<variant>.jpg` for a derivative;
// - `r/<runId>.pdf` for a generated report (reports/, D201), kept for 24 hours;
// - `x/<exportRunId>.zip` for an export's ZIP (a claim pack, incidents/, D158, Q19; a location
//   export, exports/, step 7), kept for 7 days; the export_runs CHECK allows only this key for
//   its run;
// - `i/<importRunId>.zip` for an uploaded import archive (a Homebox or Kept export, step 7, D157),
//   read by byte range and deleted when the run ends or is pruned.
// Every driver checks each key it is handed with assertBlobKey(), so a key assembled anywhere
// else (a filename, a path from a request) is refused before it reaches a disk or a bucket.

export type BlobRange = {
  /** First byte, from 0. */
  start: number;
  /** Last byte, inclusive (as HTTP `Range: bytes=start-end` gives it). */
  end: number;
};

export type SignedUrlOptions = {
  /** Seconds the URL stays valid; 300 (SIGNED_URL_TTL_SECONDS) is the default everywhere. */
  expiresIn: number;
  /** `attachment` for originals (Q16), `inline` for derivatives shown on a page. */
  disposition: 'inline' | 'attachment';
  /** The name a download is saved as. Only ever a header value, never part of a key. */
  filename: string;
  /** The sniffed type, sent as the response's Content-Type. */
  contentType: string;
};

export type BlobStore = {
  /** Stores the file at `file` (a local temp path the caller owns and removes) under `key`.
   * `bytes` is the size the caller measured; a mismatch is refused and nothing is kept. */
  put(key: string, file: string, opts: { contentType: string; bytes: number }): Promise<void>;
  /** The blob's bytes, or a byte range of them. BlobNotFoundError when there is no such blob. */
  stream(key: string, range?: BlobRange): Promise<Readable>;
  /** Removes the blob; removing one that isn't there is not an error. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** A URL the browser can fetch without a session: local → /f/<token>; S3 → presigned. */
  signedUrl(key: string, opts: SignedUrlOptions): Promise<string>;
};

/** What the file routes get from the app (http/routes.ts InventoryDeps.files). */
export type FileStorage = {
  blobs: BlobStore;
  /** Verifies `/f/<token>` for the local driver (Q16); S3 URLs are presigned by the store. */
  signer: UrlSigner;
  /** KEPT_MAX_FILE_MB in bytes (§3.4). */
  maxFileBytes: number;
  /** KEPT_IMAGE_CONCURRENCY: images resized at once, process-wide (Q17). */
  imageConcurrency: number;
  /** Where an upload is streamed while it is hashed, sniffed and resized (KEPT_DATA_DIR/tmp). */
  tmpDir: string;
};

/** The derivative renditions (`file_derivatives.variant`). */
export const BLOB_VARIANTS = ['display', 'thumb', 'share', 'poster'] as const;
export type BlobVariant = (typeof BLOB_VARIANTS)[number];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ORIGINAL = new RegExp(`^f/${UUID}/${UUID}$`);
const DERIVATIVE = new RegExp(`^d/${UUID}/(?:${BLOB_VARIANTS.join('|')})\\.jpg$`);
const REPORT = new RegExp(`^r/${UUID}\\.pdf$`);
const EXPORT = new RegExp(`^x/${UUID}\\.zip$`);
const IMPORT_ARCHIVE = new RegExp(`^i/${UUID}\\.zip$`);

export class BlobKeyError extends Error {
  constructor() {
    // The key itself is not repeated: it may have come from a request.
    super(
      'not a blob key built from ids (f/<locationId>/<fileId>, d/<fileId>/<variant>.jpg, r/<runId>.pdf, x/<runId>.zip or i/<runId>.zip)',
    );
    this.name = 'BlobKeyError';
  }
}

export class BlobNotFoundError extends Error {
  constructor() {
    super('no blob under that key');
    this.name = 'BlobNotFoundError';
  }
}

/** Whether `key` is one of the id-built shapes. Lowercase ids only: keys are made here. */
export function isBlobKey(key: string): boolean {
  return (
    ORIGINAL.test(key) ||
    DERIVATIVE.test(key) ||
    REPORT.test(key) ||
    EXPORT.test(key) ||
    IMPORT_ARCHIVE.test(key)
  );
}

/** Throws BlobKeyError unless `key` is an id-built key. */
export function assertBlobKey(key: string): string {
  if (typeof key !== 'string' || !isBlobKey(key)) throw new BlobKeyError();
  return key;
}

/** The key of an uploaded original. */
export function originalKey(locationId: string, fileId: string): string {
  return assertBlobKey(`f/${locationId.toLowerCase()}/${fileId.toLowerCase()}`);
}

/** The key of one derivative rendition of a file. */
export function derivativeKey(fileId: string, variant: BlobVariant): string {
  return assertBlobKey(`d/${fileId.toLowerCase()}/${variant}.jpg`);
}

/** The key of a generated report's PDF (reports/, D201): the run's id and nothing else. */
export function reportKey(runId: string): string {
  return assertBlobKey(`r/${runId.toLowerCase()}.pdf`);
}

/** The key of an export's ZIP (a claim pack, D158): the export run's id and nothing else. The
 * database builds the same string (kept.export_run_finish(), export_runs_storage_key_chk). */
export function exportKey(runId: string): string {
  return assertBlobKey(`x/${runId.toLowerCase()}.zip`);
}

/** The key of an uploaded import archive (step 7, plan T8): the import run's id and nothing else,
 * never a name from the upload or the archive (D157). */
export function importArchiveKey(runId: string): string {
  return assertBlobKey(`i/${runId.toLowerCase()}.zip`);
}
