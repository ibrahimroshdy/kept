import { type Readable, Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import yauzl from 'yauzl';
import type { z } from 'zod';
import type { BlobStore } from '../../storage/blob-store.js';
import { BlobRangeReader, type ReaderStats } from './blob-reader.js';
import { ARCHIVE_LIMITS, ArchiveContentError, ArchiveError, type ArchiveLimits } from './limits.js';

// The one reader of uploaded archives (D157, engineering spec §3.1b; plan T7; spike Z1). Every
// archive rule is enforced here and nowhere else:
//
// - the archive itself: at most `archiveBytes`, and a ZIP yauzl can open (a truncated or non-ZIP
//   file is `truncated`);
// - the central directory, before anything is inflated: at most `entries` entries; every name
//   valid by yauzl's strict rules (no absolute path, no `..`, no backslash: `bad_name`); no name
//   twice (`duplicate_name`); no symlink (a Unix entry whose mode is S_IFLNK: `symlink`); no
//   encrypted entry (`encrypted`); the declared sizes within `uncompressedBytes` in total
//   (`too_large`) and within `ratio` : 1 per entry once past `ratioFloorBytes` (`ratio`);
// - while inflating: the same two caps on the bytes actually inflated, counted per entry and for
//   the archive, the stream destroyed at the cap; yauzl's own `validateEntrySizes` refusal of an
//   entry that inflates past its header ("too many bytes in the stream") is `ratio` too.
//
// Entries are read only by exact expected names (`expect`); any other name is counted as
// ignored and never opened. Nothing here turns a name from an archive into a path or a storage
// key: callers look entries up by the names they expect, and nested archives are only bytes (an
// entry is never opened as a ZIP).

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/** `versionMadeBy`'s high byte for Unix, the only system whose mode bits say "symlink". */
const MADE_BY_UNIX = 3;

/** Which names the caller will read. Exact names, or a test (`attachments/<uuid>`). */
export type EntryMatcher = (name: string) => boolean;

/** Matches `names` exactly, and any name `patterns` match in full. */
export function expectNames(
  names: readonly string[],
  patterns: readonly RegExp[] = [],
): EntryMatcher {
  const exact = new Set(names);
  return (name) => exact.has(name) || patterns.some((re) => re.test(name));
}

/** `attachments/<uuid>`: a file in an export, named by its new id and nothing from the user. */
export const UUID_ENTRY = (prefix: string) =>
  new RegExp(`^${prefix}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);

export type ArchiveEntry = {
  name: string;
  /** Declared, uncompressed. Checked against the real bytes while reading. */
  size: number;
  compressedSize: number;
};

export type OpenArchive = {
  /** Entries in the central directory, directories and ignored names included. */
  readonly entryCount: number;
  /** Names not expected (and not directories): counted, never opened (`entry_ignored`). */
  readonly ignored: number;
  /** The expected entries' declared uncompressed bytes. */
  readonly declaredBytes: number;
  /** Uncompressed bytes inflated so far, by every read. */
  inflatedBytes(): number;
  /** What the reader fetched from the store (GETs on S3). */
  readonly stats: ReaderStats;
  has(name: string): boolean;
  /** The expected entries, in the directory's order. */
  entries(): AsyncIterable<ArchiveEntry>;
  /** One expected entry's bytes, counted as they inflate. ArchiveContentError('missing') when
   * the archive has no such entry. */
  read(name: string): Promise<Readable>;
  /** A whole entry, at most `limits.jsonBytes`, parsed and checked. */
  json<T>(name: string, schema: z.ZodType<T>): Promise<T>;
  /** One value per line; a blank line is skipped, a line over `limits.ndjsonLineBytes` refused. */
  ndjson<T>(name: string, schema: z.ZodType<T>): AsyncIterable<T>;
  close(): void;
};

export type OpenOptions = {
  expect: EntryMatcher;
  /** Tests lower the caps; production uses ARCHIVE_LIMITS. */
  limits?: Partial<ArchiveLimits>;
  /** The reader's block cache (tests). */
  reader?: { blockBytes?: number; maxBlocks?: number };
};

/** yauzl's messages for the names its validateFileName() and strictFileNames refuse. */
const BAD_NAME = /invalid relative path|absolute path|invalid characters|invalid file name/i;

function refusalOf(err: unknown): ArchiveError {
  if (err instanceof ArchiveError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (BAD_NAME.test(message)) return new ArchiveError('bad_name', message);
  if (/too many bytes in the stream/i.test(message)) return new ArchiveError('ratio', message);
  return new ArchiveError('truncated', message);
}

const isSymlink = (e: yauzl.Entry) =>
  e.versionMadeBy >> 8 === MADE_BY_UNIX && ((e.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;

/** Whether `inflated` bytes from `compressed` break the ratio (only past the floor, Z1). */
export function overRatio(inflated: number, compressed: number, limits: ArchiveLimits): boolean {
  return inflated > limits.ratioFloorBytes && inflated > limits.ratio * Math.max(1, compressed);
}

/** The bytes inflated so far across one archive's reads. */
export type InflateBudget = { inflated: number };

/**
 * Counts one entry's inflated bytes, and the archive's through `budget`, and fails the stream
 * (so the source is destroyed) at the ratio or the total. yauzl's validateEntrySizes stops an
 * entry at its declared size first, and the declared sizes were checked before; this counter is
 * the rule itself, on the bytes that actually came out (D157).
 */
export function inflateCounter(
  name: string,
  compressedSize: number,
  limits: ArchiveLimits,
  budget: InflateBudget,
): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      n += chunk.length;
      budget.inflated += chunk.length;
      if (budget.inflated > limits.uncompressedBytes) {
        cb(new ArchiveError('too_large', 'inflated'));
        return;
      }
      if (overRatio(n, compressedSize, limits)) {
        cb(new ArchiveError('ratio', `${name}: inflated`));
        return;
      }
      cb(null, chunk);
    },
  });
}

/**
 * Opens `key` (an id-built blob key, `bytes` long) and checks its whole central directory. Throws
 * ArchiveError for anything the rules refuse; nothing has been inflated by then.
 */
export async function openArchive(
  blobs: BlobStore,
  key: string,
  bytes: number,
  opts: OpenOptions,
): Promise<OpenArchive> {
  const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, ...opts.limits };
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ArchiveError('truncated', 'size');
  if (bytes > limits.archiveBytes) throw new ArchiveError('too_large', 'archive size');
  const reader = new BlobRangeReader(blobs, key, bytes, opts.reader);

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromRandomAccessReaderPromise(reader, bytes, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
      autoClose: false,
    });
  } catch (err) {
    throw refusalOf(err);
  }

  const expected = new Map<string, yauzl.Entry>();
  let ignored = 0;
  let declaredBytes = 0;
  try {
    // The end-of-directory record's count, before a single entry is read (a 200,001-entry
    // archive costs no directory reads at all).
    if (zip.entryCount > limits.entries) {
      throw new ArchiveError('too_many_entries', `${zip.entryCount} in the directory`);
    }
    const seen = new Set<string>();
    let declaredAll = 0;
    for await (const entry of zip.eachEntry()) {
      if (seen.size >= limits.entries) throw new ArchiveError('too_many_entries', 'directory');
      const name = entry.fileName;
      if (seen.has(name)) throw new ArchiveError('duplicate_name', name);
      seen.add(name);
      if (isSymlink(entry)) throw new ArchiveError('symlink', name);
      if (entry.isEncrypted()) throw new ArchiveError('encrypted', name);
      declaredAll += entry.uncompressedSize;
      if (declaredAll > limits.uncompressedBytes) throw new ArchiveError('too_large', 'declared');
      if (overRatio(entry.uncompressedSize, entry.compressedSize, limits)) {
        throw new ArchiveError('ratio', `${name}: declared`);
      }
      if (name.endsWith('/')) continue;
      if (!opts.expect(name)) {
        ignored++;
        continue;
      }
      declaredBytes += entry.uncompressedSize;
      expected.set(name, entry);
    }
  } catch (err) {
    zip.close();
    throw refusalOf(err);
  }

  const budget: InflateBudget = { inflated: 0 };
  const counter = (entry: yauzl.Entry) =>
    inflateCounter(entry.fileName, entry.compressedSize, limits, budget);

  const entryOf = (name: string) => {
    const entry = expected.get(name);
    if (!entry) throw new ArchiveContentError(name, 'missing');
    return entry;
  };

  const read = async (name: string): Promise<Readable> => {
    const entry = entryOf(name);
    let raw: Readable;
    try {
      raw = await zip.openReadStreamPromise(entry);
    } catch (err) {
      throw refusalOf(err);
    }
    const counted = counter(entry);
    raw.on('error', (err) => counted.destroy(refusalOf(err)));
    counted.on('close', () => {
      if (!raw.readableEnded) raw.destroy();
    });
    raw.pipe(counted);
    return counted;
  };

  const json = async <T>(name: string, schema: z.ZodType<T>): Promise<T> => {
    const stream = await read(name);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      if (size > limits.jsonBytes) {
        stream.destroy();
        throw new ArchiveError('entry_too_large', name);
      }
      chunks.push(chunk as Buffer);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ArchiveContentError(name, 'not_json');
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ArchiveContentError(name, 'schema');
    return parsed.data;
  };

  async function* ndjson<T>(name: string, schema: z.ZodType<T>): AsyncIterable<T> {
    const stream = await read(name);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let line = 0;
    const parse = (text: string): T | undefined => {
      line++;
      if (Buffer.byteLength(text) > limits.ndjsonLineBytes) {
        throw new ArchiveError('entry_too_large', `${name}: line ${line}`);
      }
      const trimmed = text.endsWith('\r') ? text.slice(0, -1) : text;
      if (trimmed.trim() === '') return undefined;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        throw new ArchiveContentError(name, 'not_json', line);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ArchiveContentError(name, 'schema', line);
      return parsed.data;
    };
    try {
      for await (const chunk of stream) {
        pending += decoder.write(chunk as Buffer);
        let at = pending.indexOf('\n');
        while (at !== -1) {
          const value = parse(pending.slice(0, at));
          pending = pending.slice(at + 1);
          if (value !== undefined) yield value;
          at = pending.indexOf('\n');
        }
        if (Buffer.byteLength(pending) > limits.ndjsonLineBytes) {
          throw new ArchiveError('entry_too_large', `${name}: line ${line + 1}`);
        }
      }
      pending += decoder.end();
      if (Buffer.byteLength(pending) > limits.ndjsonLineBytes) {
        throw new ArchiveError('entry_too_large', `${name}: line ${line + 1}`);
      }
      const last = parse(pending);
      if (last !== undefined) yield last;
    } finally {
      stream.destroy();
    }
  }

  return {
    entryCount: zip.entryCount,
    ignored,
    declaredBytes,
    inflatedBytes: () => budget.inflated,
    stats: reader.stats,
    has: (name) => expected.has(name),
    async *entries() {
      for (const [name, e] of expected) {
        yield { name, size: e.uncompressedSize, compressedSize: e.compressedSize };
      }
    },
    read,
    json,
    ndjson,
    close: () => zip.close(),
  };
}
