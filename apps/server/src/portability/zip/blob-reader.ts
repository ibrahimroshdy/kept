import { PassThrough, type Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { BlobStore } from '../../storage/blob-store.js';

// yauzl's RandomAccessReader over the BlobStore (spike Z1): an archive is read by byte range, so
// an S3 deployment never copies a 5 GB upload to local disk, and the local driver reads it in
// place. The key is always an id-built one (`i/<runId>.zip`, `x/<runId>.zip`); the store checks it.
//
// Three things the spike measured:
// - yauzl reads the central directory with two small `read()`s per entry and each local header
//   with two more. Unbuffered, that is one GET per read on S3 (about 400,000 for a 200,000-entry
//   directory). `read()` is served from BLOCK_BYTES blocks, at most MAX_BLOCKS held (LRU), one
//   GET each: a 200,001-entry directory cost 13 GETs on RustFS.
// - `_readStreamForRange()` must hand back a stream at once, and BlobStore.stream() is a promise:
//   a PassThrough is returned and the blob's stream piped into it when it arrives. An error on
//   either side destroys the other; destroying the PassThrough (yauzl does, for a stream it no
//   longer needs) destroys the source.
// - yauzl's `end` is exclusive, BlobRange's inclusive: `{start, end: end - 1}`.

export const BLOCK_BYTES = 1 << 20;
export const MAX_BLOCKS = 16;

/** What the reader asked the store for: every `stream()` call is one GET on S3. */
export type ReaderStats = {
  /** All calls to BlobStore.stream(). */
  gets: number;
  /** Block reads (the central directory and local headers). */
  blockGets: number;
  /** Entry data reads (one per opened entry). */
  dataGets: number;
};

type ReadCallback = (err: Error | null, bytesRead?: number) => void;

// @types/yauzl declares RandomAccessReader abstract with `read(..., callback: (err) => void)`;
// yauzl's own readAndAssertNoEof() reads `bytesRead` from the callback's second argument
// (index.js), so this class passes it.
const Base = yauzl.RandomAccessReader as unknown as new () => yauzl.RandomAccessReader;

export class BlobRangeReader extends Base {
  readonly stats: ReaderStats = { gets: 0, blockGets: 0, dataGets: 0 };
  readonly #blobs: BlobStore;
  readonly #key: string;
  readonly #size: number;
  readonly #blockBytes: number;
  readonly #maxBlocks: number;
  /** Insertion order is recency: the least recently used block is first. */
  readonly #blocks = new Map<number, Promise<Buffer>>();

  constructor(
    blobs: BlobStore,
    key: string,
    size: number,
    opts: { blockBytes?: number; maxBlocks?: number } = {},
  ) {
    super();
    this.#blobs = blobs;
    this.#key = key;
    this.#size = size;
    this.#blockBytes = opts.blockBytes ?? BLOCK_BYTES;
    this.#maxBlocks = opts.maxBlocks ?? MAX_BLOCKS;
  }

  #fetch(start: number, endExclusive: number): Promise<Readable> {
    this.stats.gets++;
    return this.#blobs.stream(this.#key, { start, end: endExclusive - 1 });
  }

  override _readStreamForRange(start: number, end: number): Readable {
    this.stats.dataGets++;
    const out = new PassThrough();
    let source: Readable | undefined;
    out.on('close', () => source?.destroy());
    this.#fetch(start, end).then(
      (s) => {
        source = s;
        if (out.destroyed) {
          s.destroy();
          return;
        }
        s.on('error', (err) => out.destroy(err));
        s.pipe(out);
      },
      (err: Error) => out.destroy(err),
    );
    return out;
  }

  #block(index: number): Promise<Buffer> {
    const held = this.#blocks.get(index);
    if (held) {
      this.#blocks.delete(index);
      this.#blocks.set(index, held);
      return held;
    }
    const start = index * this.#blockBytes;
    const end = Math.min(this.#size, start + this.#blockBytes);
    this.stats.blockGets++;
    const block = this.#fetch(start, end).then(async (s) => {
      const chunks: Buffer[] = [];
      for await (const chunk of s) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      if (buf.length !== end - start) throw new Error('short range read from the blob store');
      return buf;
    });
    // A failed block isn't kept: the next read asks again (and fails again, or not).
    block.catch(() => {
      if (this.#blocks.get(index) === block) this.#blocks.delete(index);
    });
    this.#blocks.set(index, block);
    while (this.#blocks.size > this.#maxBlocks) {
      const oldest = this.#blocks.keys().next().value as number;
      this.#blocks.delete(oldest);
    }
    return block;
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null) => void,
  ): void {
    const done = callback as ReadCallback;
    (async () => {
      let read = 0;
      while (read < length) {
        const at = position + read;
        if (at >= this.#size) break;
        const index = Math.floor(at / this.#blockBytes);
        const block = await this.#block(index);
        const from = at - index * this.#blockBytes;
        const n = Math.min(length - read, block.length - from);
        block.copy(buffer, offset + read, from, from + n);
        read += n;
      }
      return read;
    })().then(
      (n) => done(null, n),
      (err: Error) => done(err),
    );
  }
}

/** The reader over one blob, for yauzl.fromRandomAccessReader(). */
export function blobRandomAccessReader(
  blobs: BlobStore,
  key: string,
  size: number,
  opts?: { blockBytes?: number; maxBlocks?: number },
): BlobRangeReader {
  return new BlobRangeReader(blobs, key, size, opts);
}
