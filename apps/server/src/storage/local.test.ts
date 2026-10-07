import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlobKeyError,
  BlobNotFoundError,
  derivativeKey,
  exportKey,
  importArchiveKey,
  isBlobKey,
  originalKey,
  reportKey,
} from './blob-store.js';
import { LocalBlobStore } from './local.js';
import { createUrlSigner } from './signed-url.js';

// T2 step 4: the local driver (D157: keys from ids only, never a user-supplied name).

let dataDir: string;
let scratch: string;
let store: LocalBlobStore;
const signer = createUrlSigner(Buffer.alloc(32, 7));

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'kept-blobs-'));
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-upload-'));
  store = new LocalBlobStore({ dataDir, signer });
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

async function upload(content: string): Promise<string> {
  const file = path.join(scratch, `${newId()}.part`);
  await writeFile(file, content);
  return file;
}

describe('LocalBlobStore', () => {
  it('round-trips a blob under KEPT_DATA_DIR/blobs, mode 0640, leaving the upload alone', async () => {
    const key = originalKey(newId(), newId());
    const src = await upload('hello, kept');
    await store.put(key, src, { contentType: 'image/jpeg', bytes: 11 });

    const stored = path.join(dataDir, 'blobs', key);
    expect(await readFile(stored, 'utf8')).toBe('hello, kept');
    expect((await stat(stored)).mode & 0o777).toBe(0o640);
    expect(await readFile(src, 'utf8')).toBe('hello, kept');
    expect(await store.exists(key)).toBe(true);
    expect(await text(await store.stream(key))).toBe('hello, kept');
    // An inclusive byte range, as HTTP Range gives it.
    expect(await text(await store.stream(key, { start: 7, end: 10 }))).toBe('kept');
  });

  it('stores derivatives under d/<fileId>/<variant>.jpg', async () => {
    const key = derivativeKey(newId(), 'thumb');
    await store.put(key, await upload('thumb'), { contentType: 'image/jpeg', bytes: 5 });
    expect(await text(await store.stream(key))).toBe('thumb');
  });

  it('stores a generated report under r/<runId>.pdf, and refuses any other report shape', async () => {
    const id = newId();
    const key = reportKey(id);
    expect(key).toBe(`r/${id}.pdf`);
    await store.put(key, await upload('%PDF'), { contentType: 'application/pdf', bytes: 4 });
    expect(await text(await store.stream(key))).toBe('%PDF');
    expect(isBlobKey(`r/${id}.jpg`)).toBe(false);
    expect(isBlobKey(`r/${id}/x.pdf`)).toBe(false);
    expect(isBlobKey(`r/../${id}.pdf`)).toBe(false);
    expect(() => reportKey('not-an-id')).toThrow(BlobKeyError);
  });

  it('stores an export ZIP under x/<runId>.zip, and refuses any other export shape', async () => {
    const id = newId();
    const key = exportKey(id);
    expect(key).toBe(`x/${id}.zip`);
    expect(exportKey(id.toUpperCase())).toBe(key);
    await store.put(key, await upload('PK'), { contentType: 'application/zip', bytes: 2 });
    expect(await text(await store.stream(key))).toBe('PK');
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    expect(isBlobKey(`x/${id}.pdf`)).toBe(false);
    expect(isBlobKey(`x/${id}/a.zip`)).toBe(false);
    expect(isBlobKey(`x/../${id}.zip`)).toBe(false);
    expect(isBlobKey(`r/${id}.zip`)).toBe(false);
    expect(() => exportKey('not-an-id')).toThrow(BlobKeyError);
  });

  it('stores an import archive under i/<runId>.zip, and refuses any other archive shape', async () => {
    const id = newId();
    const key = importArchiveKey(id);
    expect(key).toBe(`i/${id}.zip`);
    expect(importArchiveKey(id.toUpperCase())).toBe(key);
    await store.put(key, await upload('PK'), { contentType: 'application/zip', bytes: 2 });
    expect(await text(await store.stream(key, { start: 0, end: 0 }))).toBe('P');
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    expect(isBlobKey('i/../x.zip')).toBe(false);
    expect(isBlobKey(`i/../${id}.zip`)).toBe(false);
    expect(isBlobKey(`i/${id.toUpperCase()}.zip`)).toBe(false);
    expect(isBlobKey(`i/${id}/a.zip`)).toBe(false);
    expect(isBlobKey(`i/${id}.pdf`)).toBe(false);
    expect(() => importArchiveKey('../x')).toThrow(BlobKeyError);
    await expect(
      store.put(`i/${id}/../../x.zip`, await upload('PK'), {
        contentType: 'application/zip',
        bytes: 2,
      }),
    ).rejects.toThrow(BlobKeyError);
  });

  it('refuses a byte count that does not match, and keeps nothing', async () => {
    const key = originalKey(newId(), newId());
    await expect(
      store.put(key, await upload('four'), { contentType: 'image/jpeg', bytes: 5 }),
    ).rejects.toThrow(/bytes/);
    expect(await store.exists(key)).toBe(false);
  });

  it.each([
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
  ])('refuses the key %j on every operation', async (key) => {
    const src = await upload('x');
    await expect(store.put(key, src, { contentType: 'image/jpeg', bytes: 1 })).rejects.toThrow(
      /key/,
    );
    await expect(store.stream(key)).rejects.toThrow(/key/);
    await expect(store.delete(key)).rejects.toThrow(/key/);
    await expect(store.exists(key)).rejects.toThrow(/key/);
  });

  it('deletes idempotently, and a missing blob is BlobNotFoundError', async () => {
    const key = originalKey(newId(), newId());
    await store.put(key, await upload('gone'), { contentType: 'image/png', bytes: 4 });
    await store.delete(key);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    await expect(store.stream(key)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('signs a /f/<token> URL that verifies back to the key and its headers', async () => {
    const key = originalKey(newId(), newId());
    const url = await store.signedUrl(key, {
      expiresIn: 300,
      disposition: 'attachment',
      filename: 'Receipt (June).pdf',
      contentType: 'application/pdf',
    });
    expect(url).toMatch(/^\/f\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(signer.verify(url.slice(3))).toMatchObject({
      key,
      disposition: 'attachment',
      filename: 'Receipt (June).pdf',
      contentType: 'application/pdf',
    });
  });
});
