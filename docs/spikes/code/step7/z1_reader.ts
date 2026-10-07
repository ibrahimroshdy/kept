/**
 * Z1: a yauzl RandomAccessReader over Kept's BlobStore, and the archive rules of D157 / §3.1b.
 * Throwaway; T7 writes the real module (apps/server/src/portability/zip/).
 */
import { PassThrough, type Readable, Transform } from 'node:stream';
import yauzl from 'yauzl';
import type { BlobStore } from '../../../../apps/server/src/storage/blob-store.ts';

export const LIMITS = {
  maxEntries: Number(process.env.Z1_MAX_ENTRIES || 200_000),
  maxTotalBytes: 5 * 1024 ** 3,
  maxRatio: 100,
  /** Below this many inflated bytes an entry's ratio isn't judged (see the spike note). */
  ratioFloorBytes: 1 << 20,
};

export class ArchiveRefused extends Error {
  constructor(
    readonly reason: string,
    detail = '',
  ) {
    super(`${reason}${detail ? `: ${detail}` : ''}`);
  }
}

export type ReaderStats = { gets: number; bytesFetched: number; metaGets: number; dataGets: number };

/**
 * yauzl reads the central directory with two small `read()`s per entry, and each entry's local
 * header with two more. Over S3 that is one GET per read, so `read()` is served from a small cache
 * of 1 MiB blocks; entry data goes through `_readStreamForRange()`, one ranged GET per entry.
 * BlobStore.stream() is async and yauzl wants a stream now: a PassThrough bridges the two.
 * yauzl's `end` is exclusive, BlobRange's is inclusive: `end - 1`.
 */
export class BlobRangeReader extends (yauzl.RandomAccessReader as unknown as { new (): object }) {
  readonly stats: ReaderStats = { gets: 0, bytesFetched: 0, metaGets: 0, dataGets: 0 };
  readonly #blocks = new Map<number, Promise<Buffer>>();

  constructor(
    readonly store: BlobStore,
    readonly key: string,
    readonly size: number,
    readonly blockSize = 1 << 20,
    readonly maxBlocks = 16,
  ) {
    super();
  }

  #fetch(start: number, endExclusive: number): Promise<Readable> {
    this.stats.gets++;
    return this.store.stream(this.key, { start, end: endExclusive - 1 });
  }

  _readStreamForRange(start: number, end: number): Readable {
    this.stats.dataGets++;
    const out = new PassThrough();
    let src: Readable | undefined;
    out.on('close', () => src?.destroy());
    this.#fetch(start, end).then(
      (s) => {
        src = s;
        if (out.destroyed) return s.destroy();
        s.on('data', (c: Buffer) => {
          this.stats.bytesFetched += c.length;
        });
        s.on('error', (e) => out.destroy(e));
        s.pipe(out);
      },
      (e) => out.destroy(e),
    );
    return out;
  }

  #block(i: number): Promise<Buffer> {
    let p = this.#blocks.get(i);
    if (p) {
      this.#blocks.delete(i);
      this.#blocks.set(i, p); // most recently used last
      return p;
    }
    const start = i * this.blockSize;
    const end = Math.min(this.size, start + this.blockSize);
    this.stats.metaGets++;
    p = this.#fetch(start, end).then(async (s) => {
      const chunks: Buffer[] = [];
      for await (const c of s) chunks.push(c as Buffer);
      const buf = Buffer.concat(chunks);
      this.stats.bytesFetched += buf.length;
      if (buf.length !== end - start) throw new Error(`short range read at ${start}`);
      return buf;
    });
    this.#blocks.set(i, p);
    while (this.#blocks.size > this.maxBlocks) {
      const oldest = this.#blocks.keys().next().value as number;
      this.#blocks.delete(oldest);
    }
    return p;
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void,
  ) {
    (async () => {
      let done = 0;
      while (done < length) {
        const pos = position + done;
        if (pos >= this.size) break;
        const i = Math.floor(pos / this.blockSize);
        const block = await this.#block(i);
        const from = pos - i * this.blockSize;
        const n = Math.min(length - done, block.length - from);
        block.copy(buffer, offset + done, from, from + n);
        done += n;
      }
      return done;
    })().then(
      (n) => callback(null, n),
      (e) => callback(e as Error),
    );
  }
}

type Entry = yauzl.Entry;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export type OpenArchive = {
  zip: yauzl.ZipFile;
  entries: Map<string, Entry>;
  reader: BlobRangeReader;
  declaredBytes: number;
};

/** Opens an archive and checks everything the central directory can tell before any inflating. */
export async function openArchive(store: BlobStore, key: string, size: number): Promise<OpenArchive> {
  if (size > LIMITS.maxTotalBytes) throw new ArchiveRefused('archive_too_large', `${size} bytes`);
  const reader = new BlobRangeReader(store, key, size);
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromRandomAccessReaderPromise(reader as never, size, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
      autoClose: false,
    });
  } catch (e) {
    throw new ArchiveRefused('archive_invalid', (e as Error).message);
  }
  if (zip.entryCount > LIMITS.maxEntries) {
    zip.close();
    throw new ArchiveRefused('too_many_entries', `${zip.entryCount} in the directory`);
  }
  const entries = new Map<string, Entry>();
  let declaredBytes = 0;
  let seen = 0;
  try {
    for await (const e of zip.eachEntry()) {
      if (++seen > LIMITS.maxEntries) throw new ArchiveRefused('too_many_entries', `more than ${LIMITS.maxEntries}`);
      const name = e.fileName;
      if (entries.has(name)) throw new ArchiveRefused('duplicate_name', name);
      const madeBy = e.versionMadeBy >> 8;
      const mode = (e.externalFileAttributes >>> 16) & S_IFMT;
      if (madeBy === 3 && mode === S_IFLNK) throw new ArchiveRefused('symlink', name);
      if (e.isEncrypted()) throw new ArchiveRefused('encrypted', name);
      declaredBytes += e.uncompressedSize;
      // Z1_NO_HEADER_CHECKS: trust nothing the headers declare, to show the inflate-time counters.
      if (process.env.Z1_NO_HEADER_CHECKS) {
        entries.set(name, e);
        continue;
      }
      if (declaredBytes > LIMITS.maxTotalBytes) throw new ArchiveRefused('archive_too_large', 'declared');
      if (
        e.uncompressedSize > LIMITS.ratioFloorBytes &&
        e.uncompressedSize > LIMITS.maxRatio * Math.max(1, e.compressedSize)
      ) {
        throw new ArchiveRefused('ratio', `${name} declares ${e.uncompressedSize}/${e.compressedSize}`);
      }
      entries.set(name, e);
    }
  } catch (e) {
    zip.close();
    if (e instanceof ArchiveRefused) throw e;
    // yauzl's own refusals: validateFileName() (absolute, "..", backslash), bad headers, EOF.
    const msg = (e as Error).message;
    const reason = /invalid relative path|absolute path|invalid characters/i.test(msg) ? 'invalid_name' : 'archive_invalid';
    throw new ArchiveRefused(reason, msg);
  }
  return { zip, entries, reader, declaredBytes };
}

/** Counts bytes actually inflated, per entry (ratio) and per archive (total), and stops at a cap. */
export class Budget {
  inflated = 0;
  entryStream(e: Entry): Transform {
    let n = 0;
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        n += chunk.length;
        this.inflated += chunk.length;
        if (this.inflated > LIMITS.maxTotalBytes) return cb(new ArchiveRefused('archive_too_large', 'inflated'));
        if (n > LIMITS.ratioFloorBytes && n > LIMITS.maxRatio * Math.max(1, e.compressedSize)) {
          return cb(new ArchiveRefused('ratio', `${e.fileName} inflated ${n} from ${e.compressedSize}`));
        }
        cb(null, chunk);
      },
    });
  }
}

export async function readEntry(a: OpenArchive, e: Entry, budget: Budget, sink?: (c: Buffer) => void) {
  const rs = await a.zip.openReadStreamPromise(e);
  const counted = rs.pipe(budget.entryStream(e));
  rs.on('error', (err) => counted.destroy(err));
  try {
    for await (const c of counted) sink?.(c as Buffer);
  } catch (err) {
    rs.destroy();
    if (err instanceof ArchiveRefused) throw err;
    throw new ArchiveRefused('entry_invalid', `${e.fileName}: ${(err as Error).message}`);
  }
}
