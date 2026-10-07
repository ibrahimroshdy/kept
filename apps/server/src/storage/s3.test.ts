import { randomBytes } from 'node:crypto';
import { ReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchBucket,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { blobStoreContract } from '../../test/blob-store-contract.js';
import { loadEnv } from '../config/env.js';
import { BlobNotFoundError, derivativeKey, originalKey } from './blob-store.js';
import { createBlobStore } from './create.js';
import { LocalBlobStore } from './local.js';
import { contentDisposition, S3BlobStore, type S3BlobStoreOptions } from './s3.js';
import { createUrlSigner } from './signed-url.js';

// T18: the S3 driver (Q18). Two halves:
// - unit tests with the client's `send` stubbed, for the requests the driver builds, plus
//   presigning, which is offline;
// - the shared BlobStore contract and real presigned fetches against RustFS
//   (`docker compose -f compose.dev.yaml --profile s3 up -d`, port 9452).

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-s3-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function upload(content: string | Buffer): Promise<string> {
  const file = path.join(scratch, `${newId()}.part`);
  await writeFile(file, content);
  return file;
}

const OFFLINE: S3BlobStoreOptions = {
  bucket: 'kept-unit',
  region: 'us-east-1',
  endpoint: 'http://localhost:9452',
  forcePathStyle: true,
  credentials: { accessKeyId: 'unit-key', secretAccessKey: 'unit-secret' },
};

/** A store whose client never touches the network: each command goes to `reply`. */
function stubbed(reply: (command: object) => unknown = () => ({})) {
  const store = new S3BlobStore(OFFLINE);
  const sent: object[] = [];
  vi.spyOn(store.client, 'send').mockImplementation((async (command: object) => {
    sent.push(command);
    return reply(command);
  }) as never);
  return { store, sent };
}

const s3Error = (status: number, name = 'InternalError') =>
  new S3ServiceException({ name, $fault: 'server', $metadata: { httpStatusCode: status } });

describe('S3BlobStore requests', () => {
  it('puts the temp file as a stream with its length and type', async () => {
    const { store, sent } = stubbed();
    const key = originalKey(newId(), newId());
    const file = await upload('hello, kept');
    await store.put(key, file, { contentType: 'image/jpeg', bytes: 11 });

    expect(sent).toHaveLength(1);
    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'kept-unit',
      Key: key,
      ContentLength: 11,
      ContentType: 'image/jpeg',
    });
    expect(command.input.Body).toBeInstanceOf(ReadStream);
    expect((command.input.Body as ReadStream).path).toBe(file);
    // The stream is closed whatever happened to the request.
    expect((command.input.Body as ReadStream).destroyed).toBe(true);
  });

  it('refuses a byte count that does not match before sending anything', async () => {
    const { store, sent } = stubbed();
    await expect(
      store.put(originalKey(newId(), newId()), await upload('four'), {
        contentType: 'image/jpeg',
        bytes: 5,
      }),
    ).rejects.toThrow(/4 bytes, expected 5/);
    expect(sent).toHaveLength(0);
  });

  it('closes the file stream when the upload fails', async () => {
    const { store, sent } = stubbed(() => {
      throw s3Error(500);
    });
    await expect(
      store.put(derivativeKey(newId(), 'thumb'), await upload('x'), {
        contentType: 'image/jpeg',
        bytes: 1,
      }),
    ).rejects.toThrow();
    expect(((sent[0] as PutObjectCommand).input.Body as ReadStream).destroyed).toBe(true);
  });

  it('streams with an inclusive Range header, and without one for the whole blob', async () => {
    const { store, sent } = stubbed(() => ({ Body: Readable.from(['kept']) }));
    const key = originalKey(newId(), newId());
    await store.stream(key, { start: 7, end: 10 });
    await store.stream(key);
    const [ranged, whole] = sent as GetObjectCommand[];
    expect(ranged).toBeInstanceOf(GetObjectCommand);
    expect(ranged?.input).toEqual({ Bucket: 'kept-unit', Key: key, Range: 'bytes=7-10' });
    expect(whole?.input).toEqual({ Bucket: 'kept-unit', Key: key });
  });

  it.each([
    { start: -1, end: 3 },
    { start: 5, end: 4 },
    { start: 0.5, end: 4 },
  ])('refuses the range %j', async (range) => {
    const { store, sent } = stubbed();
    await expect(store.stream(originalKey(newId(), newId()), range)).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
  });

  it('maps a missing object to BlobNotFoundError, but not a missing bucket', async () => {
    const key = originalKey(newId(), newId());
    const missing = stubbed(() => {
      throw new NoSuchKey({ message: 'gone', $metadata: { httpStatusCode: 404 } });
    });
    await expect(missing.store.stream(key)).rejects.toBeInstanceOf(BlobNotFoundError);

    const noBucket = stubbed(() => {
      throw new NoSuchBucket({ message: 'no bucket', $metadata: { httpStatusCode: 404 } });
    });
    await expect(noBucket.store.stream(key)).rejects.toBeInstanceOf(NoSuchBucket);
  });

  it('deletes with DeleteObject, and a 404 from a compatible store is not an error', async () => {
    const key = derivativeKey(newId(), 'display');
    const ok = stubbed();
    await ok.store.delete(key);
    expect(ok.sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((ok.sent[0] as DeleteObjectCommand).input).toEqual({ Bucket: 'kept-unit', Key: key });

    const notThere = stubbed(() => {
      throw s3Error(404, 'NoSuchKey');
    });
    await expect(notThere.store.delete(key)).resolves.toBeUndefined();

    const broken = stubbed(() => {
      throw s3Error(500);
    });
    await expect(broken.store.delete(key)).rejects.toThrow();
  });

  it('checks existence with HeadObject: 404 is false, anything else throws', async () => {
    const key = originalKey(newId(), newId());
    const there = stubbed();
    expect(await there.store.exists(key)).toBe(true);
    expect(there.sent[0]).toBeInstanceOf(HeadObjectCommand);
    expect((there.sent[0] as HeadObjectCommand).input).toEqual({ Bucket: 'kept-unit', Key: key });

    const gone = stubbed(() => {
      throw new NotFound({ message: 'not found', $metadata: { httpStatusCode: 404 } });
    });
    expect(await gone.store.exists(key)).toBe(false);

    const forbidden = stubbed(() => {
      throw s3Error(403, 'AccessDenied');
    });
    await expect(forbidden.store.exists(key)).rejects.toThrow();
  });

  it('refuses keys that are not built from ids before sending anything', async () => {
    const { store, sent } = stubbed();
    const bad = `f/${newId()}/photo.jpg`;
    await expect(
      store.put(bad, await upload('x'), { contentType: 'image/jpeg', bytes: 1 }),
    ).rejects.toThrow(/key/);
    await expect(store.stream(bad)).rejects.toThrow(/key/);
    await expect(store.delete(bad)).rejects.toThrow(/key/);
    await expect(store.exists(bad)).rejects.toThrow(/key/);
    expect(sent).toHaveLength(0);
  });
});

describe('S3BlobStore presigned URLs (offline)', () => {
  const store = new S3BlobStore(OFFLINE);
  afterAll(() => store.destroy());

  it('presigns a path-style GET that carries the disposition, type, caching and expiry', async () => {
    const key = originalKey(newId(), newId());
    const url = new URL(
      await store.signedUrl(key, {
        expiresIn: 300,
        disposition: 'attachment',
        filename: 'Receipt (June).pdf',
        contentType: 'application/pdf',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`http://localhost:9452/kept-unit/${key}`);
    const q = url.searchParams;
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Expires')).toBe('300');
    expect(q.get('X-Amz-Credential')).toMatch(/^unit-key\//);
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(q.get('response-content-disposition')).toBe(
      contentDisposition('attachment', 'Receipt (June).pdf'),
    );
    expect(q.get('response-content-type')).toBe('application/pdf');
    expect(q.get('response-cache-control')).toBe('private, max-age=300');
    // No flexible-checksum mode: some S3-compatible stores refuse it on a presigned GET.
    expect(q.has('x-amz-checksum-mode')).toBe(false);
    expect(url.toString()).not.toContain('unit-secret');
  });

  it.each([0, -5, 1.5, 86_401])('refuses a lifetime of %j seconds', async (expiresIn) => {
    await expect(
      store.signedUrl(originalKey(newId(), newId()), {
        expiresIn,
        disposition: 'inline',
        filename: 'x.jpg',
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(RangeError);
  });

  it('refuses a key that is not built from ids', async () => {
    await expect(
      store.signedUrl('f/../x', {
        expiresIn: 300,
        disposition: 'inline',
        filename: 'x.jpg',
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/key/);
  });
});

describe('contentDisposition', () => {
  it('gives an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'Receipt (June).pdf')).toBe(
      `attachment; filename="Receipt (June).pdf"; filename*=UTF-8''Receipt%20%28June%29.pdf`,
    );
    expect(contentDisposition('inline', 'فاتورة.pdf')).toBe(
      `inline; filename="______.pdf"; filename*=UTF-8''${encodeURIComponent('فاتورة')}.pdf`,
    );
  });

  it('never lets quotes, backslashes or line breaks into the header', () => {
    const value = contentDisposition('attachment', 'a"b\\c\r\nSet-Cookie: x=1.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.split('"')).toHaveLength(3);
    expect(value).toContain('filename="a_b_c__Set-Cookie: x=1.pdf"');
  });

  it('names an empty filename "file"', () => {
    expect(contentDisposition('inline', '')).toBe('inline; filename="file"');
  });
});

describe('createBlobStore', () => {
  const base = {
    KEPT_DATABASE_URL: 'postgres://kept_app:kept_app@localhost:5452/kept',
    KEPT_AUTH_DATABASE_URL: 'postgres://kept_auth:kept_auth@localhost:5452/kept',
    KEPT_SYSTEM_DATABASE_URL: 'postgres://kept_system:kept_system@localhost:5452/kept',
    KEPT_PUBLIC_URL: 'http://localhost:5173',
    KEPT_SECRET_KEY: randomBytes(32).toString('base64url'),
    KEPT_AUTH_SECRET: randomBytes(32).toString('base64url'),
  };
  const signer = createUrlSigner(Buffer.alloc(32, 3));

  it('is the local driver by default', async () => {
    const env = await loadEnv({ ...base, KEPT_DATA_DIR: scratch });
    const store = await createBlobStore(env, signer);
    expect(store).toBeInstanceOf(LocalBlobStore);
    expect((store as LocalBlobStore).root).toBe(path.join(scratch, 'blobs'));
  });

  it('is the S3 driver with KEPT_STORAGE=s3, configured from KEPT_S3_*', async () => {
    const env = await loadEnv({
      ...base,
      KEPT_STORAGE: 's3',
      KEPT_S3_ENDPOINT: 'http://localhost:9452',
      KEPT_S3_REGION: 'eu-west-1',
      KEPT_S3_BUCKET: 'kept-files',
      KEPT_S3_ACCESS_KEY_ID: 'env-key',
      KEPT_S3_SECRET_ACCESS_KEY: 'env-secret',
      KEPT_S3_FORCE_PATH_STYLE: 'true',
    });
    const store = (await createBlobStore(env, signer)) as S3BlobStore;
    try {
      expect(store).toBeInstanceOf(S3BlobStore);
      expect(store.bucket).toBe('kept-files');
      expect(store.client.config.forcePathStyle).toBe(true);
      expect(await store.client.config.region()).toBe('eu-west-1');
      expect(await store.client.config.credentials()).toMatchObject({
        accessKeyId: 'env-key',
        secretAccessKey: 'env-secret',
      });
      const url = new URL(
        await store.signedUrl(derivativeKey(newId(), 'thumb'), {
          expiresIn: 60,
          disposition: 'inline',
          filename: 'thumb.jpg',
          contentType: 'image/jpeg',
        }),
      );
      expect(url.host).toBe('localhost:9452');
      expect(url.pathname.startsWith('/kept-files/d/')).toBe(true);
    } finally {
      store.destroy();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Against a real S3-compatible store: RustFS from compose.dev.yaml's `s3` profile. CI sets
// KEPT_TEST_S3_URL (scripts/ci-local.sh), and then an unreachable store fails the run. Without
// it the suite tries the dev port and, when nothing answers, skips with a warning.

const S3_URL = process.env.KEPT_TEST_S3_URL || 'http://localhost:9452';
const S3_REQUIRED = Boolean(process.env.KEPT_TEST_S3_URL);

async function reachable(url: string): Promise<boolean> {
  try {
    // Any HTTP answer (an S3 root is a 403 without credentials) means something is listening.
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

const live = await reachable(S3_URL);
const SKIP_REASON = `no S3 store at ${S3_URL}; start it with \`docker compose -f compose.dev.yaml --profile s3 up -d --wait\``;
if (!live && !S3_REQUIRED) {
  // Straight to stderr: vitest holds console output of passing files back.
  process.stderr.write(
    `\n${'!'.repeat(78)}\n! storage/s3.test.ts: the RustFS tests are SKIPPED.\n! ${SKIP_REASON}\n${'!'.repeat(78)}\n\n`,
  );
}
// The reason also shows in the report, as a skipped test of its own.
if (!live && !S3_REQUIRED) it.skip(`S3BlobStore against a real store: ${SKIP_REASON}`, () => {});

describe.skipIf(!live && !S3_REQUIRED)(`S3BlobStore against ${S3_URL}`, () => {
  // One bucket per run, emptied and removed afterwards.
  const bucket = `kept-test-${randomBytes(6).toString('hex')}`;
  const store = new S3BlobStore({
    bucket,
    region: 'us-east-1',
    endpoint: S3_URL,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.KEPT_TEST_S3_ACCESS_KEY_ID || 'kept-dev',
      secretAccessKey: process.env.KEPT_TEST_S3_SECRET_ACCESS_KEY || 'kept-dev-secret',
    },
  });

  beforeAll(async () => {
    if (!live) throw new Error(`KEPT_TEST_S3_URL is set but nothing answers at ${S3_URL}`);
    await store.ensureBucket();
  });

  afterAll(async () => {
    if (!live) return;
    const client = store.client;
    for (;;) {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length === 0) break;
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    store.destroy();
  });

  it('creates the bucket once; ensureBucket is idempotent', async () => {
    await expect(store.ensureBucket()).resolves.toBeUndefined();
  });

  blobStoreContract('S3BlobStore', async () => store);

  it('stores the content type given at upload', async () => {
    const key = originalKey(newId(), newId());
    await store.put(key, await upload('%PDF-1.7'), { contentType: 'application/pdf', bytes: 8 });
    const head = await store.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(head.ContentType).toBe('application/pdf');
    expect(head.ContentLength).toBe(8);
  });

  it('serves a presigned URL to a plain fetch, with the bytes and the headers', async () => {
    const key = originalKey(newId(), newId());
    const bytes = randomBytes(4096);
    await store.put(key, await upload(bytes), { contentType: 'image/jpeg', bytes: bytes.length });
    const filename = 'Receipt (June) – فاتورة.jpg';
    const url = await store.signedUrl(key, {
      expiresIn: 300,
      disposition: 'attachment',
      filename,
      contentType: 'image/jpeg',
    });

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect(res.headers.get('content-disposition')).toBe(contentDisposition('attachment', filename));
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('set-cookie')).toBeNull();

    // A range through the same URL, as a browser's media element would ask.
    const ranged = await fetch(url, { headers: { Range: 'bytes=10-19' } });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
  });

  it('refuses a presigned URL whose key or overrides were changed', async () => {
    const key = originalKey(newId(), newId());
    await store.put(key, await upload('secret'), { contentType: 'image/jpeg', bytes: 6 });
    const url = new URL(
      await store.signedUrl(key, {
        expiresIn: 300,
        disposition: 'inline',
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      }),
    );

    const otherKey = new URL(url);
    otherKey.pathname = `/${bucket}/${originalKey(newId(), newId())}`;
    expect((await fetch(otherKey)).status).toBe(403);

    const otherType = new URL(url);
    otherType.searchParams.set('response-content-type', 'text/html');
    expect((await fetch(otherType)).status).toBe(403);
  });

  it('refuses a presigned URL once it has expired', async () => {
    const key = derivativeKey(newId(), 'share');
    await store.put(key, await upload('soon gone'), { contentType: 'image/jpeg', bytes: 9 });
    const url = await store.signedUrl(key, {
      expiresIn: 1,
      disposition: 'inline',
      filename: 'share.jpg',
      contentType: 'image/jpeg',
    });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect((await fetch(url)).status).toBe(403);
  });
});
