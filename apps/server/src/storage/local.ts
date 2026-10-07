import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  assertBlobKey,
  BlobNotFoundError,
  type BlobRange,
  type BlobStore,
  type SignedUrlOptions,
} from './blob-store.js';
import type { UrlSigner } from './signed-url.js';

// The local driver (KEPT_STORAGE=local, the default): blobs are files under
// KEPT_DATA_DIR/blobs/<key>. A write lands under a temp name in the destination's own directory
// (so the same filesystem) and is renamed into place, so a reader never sees half a file and a
// crash leaves at most a stray `.tmp`. Mode 0640: the serving user and its group, nobody else.

const FILE_MODE = 0o640;
const DIR_MODE = 0o750;

export type LocalBlobStoreOptions = {
  /** KEPT_DATA_DIR; blobs go in its `blobs/` directory. */
  dataDir: string;
  /** Signs `/f/<token>` URLs (signed-url.ts). */
  signer: UrlSigner;
};

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export class LocalBlobStore implements BlobStore {
  readonly root: string;
  readonly #signer: UrlSigner;

  constructor(opts: LocalBlobStoreOptions) {
    this.root = path.resolve(opts.dataDir, 'blobs');
    this.#signer = opts.signer;
  }

  /** The file behind a key. The key shape already rules out `..` and absolute paths; the
   * containment check is a second lock on the same door. */
  #pathOf(key: string): string {
    assertBlobKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(`${this.root}${path.sep}`)) throw new Error('blob key escapes the root');
    return full;
  }

  async put(key: string, file: string, opts: { contentType: string; bytes: number }) {
    const dest = this.#pathOf(key);
    await mkdir(path.dirname(dest), { recursive: true, mode: DIR_MODE });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    try {
      await copyFile(file, tmp);
      const { size } = await stat(tmp);
      if (size !== opts.bytes) {
        throw new Error(`blob is ${size} bytes, expected ${opts.bytes}`);
      }
      await chmod(tmp, FILE_MODE);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async stream(key: string, range?: BlobRange): Promise<Readable> {
    const file = this.#pathOf(key);
    try {
      await stat(file);
    } catch (err) {
      if (isMissing(err)) throw new BlobNotFoundError();
      throw err;
    }
    return createReadStream(file, range ? { start: range.start, end: range.end } : {});
  }

  async delete(key: string) {
    await rm(this.#pathOf(key), { force: true });
  }

  async exists(key: string) {
    try {
      return (await stat(this.#pathOf(key))).isFile();
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async signedUrl(key: string, opts: SignedUrlOptions) {
    const token = this.#signer.sign(
      {
        key: assertBlobKey(key),
        disposition: opts.disposition,
        filename: opts.filename,
        contentType: opts.contentType,
      },
      opts.expiresIn,
    );
    return `/f/${token}`;
  }
}
