import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { fixture, sha256, upload } from '../../test/files.js';
import { call, type Person, peopleApp, person } from '../../test/people.js';
import { originalKey } from '../storage/blob-store.js';
import { S3BlobStore } from '../storage/s3.js';
import { createUrlSigner } from '../storage/signed-url.js';

// T17 on S3 (Q18, D157): the same upload and serving, with the blobs in RustFS and the browser
// sent to presigned URLs. Like storage/s3.test.ts, it runs against KEPT_TEST_S3_URL (CI) and
// fails when that store isn't answering; without the variable it tries the dev port and skips
// when nothing is there.

const S3_URL = process.env.KEPT_TEST_S3_URL || 'http://localhost:9452';
const S3_REQUIRED = Boolean(process.env.KEPT_TEST_S3_URL);
const credentials = {
  accessKeyId: process.env.KEPT_TEST_S3_ACCESS_KEY_ID || 'kept-dev',
  secretAccessKey: process.env.KEPT_TEST_S3_SECRET_ACCESS_KEY || 'kept-dev-secret',
};

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

describe('KEPT_S3_PUBLIC_ENDPOINT (T18 decision)', () => {
  it('signs browser URLs for the public host, and talks to the store on the private one', async () => {
    const store = new S3BlobStore({
      bucket: 'kept',
      region: 'us-east-1',
      endpoint: 'http://rustfs:9000',
      publicEndpoint: 'https://files.example.com',
      forcePathStyle: true,
      credentials,
    });
    try {
      const url = await store.signedUrl(originalKey(newId(), newId()), {
        expiresIn: 300,
        disposition: 'attachment',
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      });
      expect(url).toMatch(/^https:\/\/files\.example\.com\/kept\/f\//);
      expect(await store.client.config.endpoint?.()).toMatchObject({ hostname: 'rustfs' });
    } finally {
      store.destroy();
    }
  });
});

const live = await reachable(S3_URL);
if (!live && !S3_REQUIRED) {
  it.skip(`files on S3: no store at ${S3_URL}`, () => {});
}

describe.skipIf(!live && !S3_REQUIRED)(`files on S3 (${S3_URL})`, () => {
  const bucket = `kept-files-${randomBytes(6).toString('hex')}`;
  const store = new S3BlobStore({
    bucket,
    region: 'us-east-1',
    endpoint: S3_URL,
    forcePathStyle: true,
    credentials,
  });
  let db: TestDb;
  let t: TestApp;
  let dir: string;
  let ann: Person;

  beforeAll(async () => {
    if (!live) throw new Error(`KEPT_TEST_S3_URL is set but nothing answers at ${S3_URL}`);
    await store.ensureBucket();
    dir = await mkdtemp(path.join(tmpdir(), 'kept-files-s3-'));
    db = await testDb();
    await db.reset();
    t = await peopleApp(db, {
      files: {
        blobs: store,
        signer: createUrlSigner(randomBytes(32)),
        maxFileBytes: 25 * 1024 * 1024,
        imageConcurrency: 1,
        tmpDir: dir,
      },
    });
    ann = await person(t, db, 'ann');
  });

  afterAll(async () => {
    await t?.app.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (!live) return;
    for (;;) {
      const listed = await store.client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length === 0) break;
      await store.client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
      );
    }
    await store.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    store.destroy();
  });

  it('stores the original byte-identical and serves it through a presigned URL', async () => {
    const bytes = await fixture('photo.jpg');
    const up = await upload(t, ann, ann.personalLocationId, bytes);
    expect(up.statusCode, up.body).toBe(201);
    const view = up.json() as { id: string; thumbUrl: string };
    expect(view.thumbUrl).toMatch(new RegExp(`^${S3_URL}/${bucket}/d/`));

    const original = await call(t, `/api/v1/files/${view.id}/url`, {
      as: ann,
      body: { variant: 'original' },
    });
    expect(original.statusCode, original.body).toBe(200);
    const res = await fetch((original.json() as { url: string }).url);
    expect(res.status).toBe(200);
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(sha256(bytes));
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; /);

    const thumb = await fetch(view.thumbUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-disposition')).toMatch(/^inline; /);
  });
});
