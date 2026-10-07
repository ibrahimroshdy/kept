import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlobNotFoundError,
  type BlobStore,
  derivativeKey,
  originalKey,
  type SignedUrlOptions,
} from '../src/storage/blob-store.js';

// What every BlobStore driver promises (blob-store.ts), run against each of them: local.ts in
// storage/blob-store-contract.test.ts, s3.ts against RustFS in storage/s3.test.ts (T18). What
// only one driver does (file modes, the shape of a signed URL) stays in that driver's tests.

/** Keys that aren't built from ids (D157). Every operation refuses them before any I/O. */
export const FOREIGN_KEYS = [
  '../etc/passwd',
  '/f/abc',
  'f/../../etc/passwd',
  `f/${newId()}/../${newId()}`,
  `f/${newId()}/photo.jpg`,
  `x/${newId()}/${newId()}`,
  `d/${newId()}/original.jpg`,
  `f/${newId()}`,
  `F/${newId()}/${newId()}`,
  '',
];

export function blobStoreContract(name: string, makeStore: () => Promise<BlobStore>): void {
  describe(`${name}: the BlobStore contract`, () => {
    let store: BlobStore;
    let scratch: string;

    beforeAll(async () => {
      store = await makeStore();
      scratch = await mkdtemp(path.join(tmpdir(), 'kept-contract-'));
    });
    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true });
    });

    async function upload(content: string | Buffer): Promise<string> {
      const file = path.join(scratch, `${newId()}.part`);
      await writeFile(file, content);
      return file;
    }

    it('round-trips an original, and serves an inclusive byte range', async () => {
      const key = originalKey(newId(), newId());
      await store.put(key, await upload('hello, kept'), { contentType: 'image/jpeg', bytes: 11 });
      expect(await store.exists(key)).toBe(true);
      expect(await text(await store.stream(key))).toBe('hello, kept');
      expect(await text(await store.stream(key, { start: 7, end: 10 }))).toBe('kept');
      expect(await text(await store.stream(key, { start: 0, end: 0 }))).toBe('h');
    });

    it('keeps binary bytes identical (D117)', async () => {
      const key = originalKey(newId(), newId());
      const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31 + 7) % 256));
      await store.put(key, await upload(bytes), {
        contentType: 'application/pdf',
        bytes: bytes.length,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of await store.stream(key)) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    });

    it('overwrites a key that is put again', async () => {
      const key = derivativeKey(newId(), 'thumb');
      await store.put(key, await upload('first'), { contentType: 'image/jpeg', bytes: 5 });
      await store.put(key, await upload('second'), { contentType: 'image/jpeg', bytes: 6 });
      expect(await text(await store.stream(key))).toBe('second');
    });

    it('refuses a byte count that does not match, and keeps nothing', async () => {
      const key = originalKey(newId(), newId());
      await expect(
        store.put(key, await upload('four'), { contentType: 'image/jpeg', bytes: 5 }),
      ).rejects.toThrow(/bytes/);
      expect(await store.exists(key)).toBe(false);
    });

    it('answers a missing blob with exists=false and BlobNotFoundError', async () => {
      const key = originalKey(newId(), newId());
      expect(await store.exists(key)).toBe(false);
      await expect(store.stream(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    });

    it('deletes idempotently', async () => {
      const key = derivativeKey(newId(), 'display');
      await store.put(key, await upload('gone'), { contentType: 'image/jpeg', bytes: 4 });
      await store.delete(key);
      await store.delete(key);
      expect(await store.exists(key)).toBe(false);
      await expect(store.stream(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    });

    it.each(FOREIGN_KEYS)('refuses the key %j on every operation', async (key) => {
      const src = await upload('x');
      const url: SignedUrlOptions = {
        expiresIn: 300,
        disposition: 'inline',
        filename: 'x',
        contentType: 'image/jpeg',
      };
      await expect(store.put(key, src, { contentType: 'image/jpeg', bytes: 1 })).rejects.toThrow(
        /key/,
      );
      await expect(store.stream(key)).rejects.toThrow(/key/);
      await expect(store.delete(key)).rejects.toThrow(/key/);
      await expect(store.exists(key)).rejects.toThrow(/key/);
      await expect(store.signedUrl(key, url)).rejects.toThrow(/key/);
    });

    it('signs a URL for a blob', async () => {
      const key = originalKey(newId(), newId());
      const url = await store.signedUrl(key, {
        expiresIn: 300,
        disposition: 'attachment',
        filename: 'Receipt (June).pdf',
        contentType: 'application/pdf',
      });
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    });
  });
}
