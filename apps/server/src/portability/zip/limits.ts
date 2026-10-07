import { type ArchiveRefusal, ZIP_LIMITS } from '@kept/shared';
import { AppError } from '../../http/errors.js';

// The archive rules' numbers (D157, engineering spec §3.1b; spike Z1,
// docs/spikes/2026-09-30-step7-archive.md) and the one error every refusal is thrown as. The
// numbers the web shares are @kept/shared's ZIP_LIMITS; the reader's own caps are added here.

export type ArchiveLimits = {
  /** Entries in the central directory. */
  entries: number;
  /** Uncompressed bytes in the whole archive, declared and actually inflated. */
  uncompressedBytes: number;
  /** Inflated : compressed, per entry, judged once the entry is past `ratioFloorBytes`. */
  ratio: number;
  ratioFloorBytes: number;
  /** The archive file itself. */
  archiveBytes: number;
  /** One entry read whole by `json()`. */
  jsonBytes: number;
  /** One line of an `ndjson()` entry. */
  ndjsonLineBytes: number;
};

export const ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  ...ZIP_LIMITS,
  jsonBytes: 64 * 1024 ** 2,
  ndjsonLineBytes: 1024 ** 2,
});

/**
 * An archive Kept won't read, with the reason the web translates (ARCHIVE_REFUSALS). `detail` is
 * for the log only: it may hold a name from the archive, so it never goes into a response.
 */
export class ArchiveError extends Error {
  readonly reason: ArchiveRefusal;
  readonly detail: string;

  constructor(reason: ArchiveRefusal, detail = '') {
    super(`archive refused: ${reason}`);
    this.name = 'ArchiveError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * What an archive holds that its reader can't use: an entry that isn't there, isn't JSON, or
 * doesn't match its schema. Not an archive rule: the importer decides (a missing optional file
 * is an issue in the dry run; a bad manifest fails the run). `line` counts from 1.
 */
export class ArchiveContentError extends Error {
  readonly entry: string;
  readonly problem: 'missing' | 'not_json' | 'schema';
  readonly line: number | null;

  constructor(entry: string, problem: ArchiveContentError['problem'], line: number | null = null) {
    super(`archive entry ${entry}: ${problem}${line === null ? '' : ` at line ${line}`}`);
    this.name = 'ArchiveContentError';
    this.entry = entry;
    this.problem = problem;
    this.line = line;
  }
}

/** The HTTP error for a refusal: 413 `archive_too_large` for the size caps, else 400
 * `archive_invalid`, both with `{reason}` (plan T7). */
export function archiveHttpError(err: ArchiveError): AppError {
  return err.reason === 'too_large'
    ? new AppError('archive_too_large', 413, undefined, { reason: err.reason })
    : new AppError('archive_invalid', 400, undefined, { reason: err.reason });
}
