import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { ownerTx, seedTenant } from '../../test/tenancy.js';
import { storageCopyCommand, storageVerifyCommand } from '../cli/storage.js';
import { derivativeKey, originalKey } from './blob-store.js';
import { blobsToCopy, type CopyEntry, copyBlobs, verifyBlobs } from './copy.js';
import { LocalBlobStore } from './local.js';
import { S3BlobStore } from './s3.js';
import { createUrlSigner } from './signed-url.js';

// Switching file storage (D186; plan T13): every referenced blob copied with its hash checked,
// resumable, a wrong destination object copied over, and the CLI from local to RustFS and back.

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const scratch: string[] = [];
const newDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-storage-copy-'));
  scratch.push(dir);
  return dir;
};
const localStore = (dir: string) =>
  new LocalBlobStore({ dataDir: dir, signer: createUrlSigner(randomBytes(32)) });

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function putBytes(
  store: { put: LocalBlobStore['put'] },
  dir: string,
  key: string,
  b: Buffer,
) {
  const file = path.join(dir, `${newId()}.bin`);
  await writeFile(file, b);
  await store.put(key, file, { contentType: 'application/octet-stream', bytes: b.length });
  await rm(file);
}

async function readAll(store: LocalBlobStore | S3BlobStore, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await store.stream(key)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('copyBlobs between two local stores', () => {
  it('copies, skips what is there, replaces wrong bytes, and reports a missing or bad source', async () => {
    const a = await newDir();
    const b = await newDir();
    const from = localStore(a);
    const to = localStore(b);
    const loc = newId();
    const one = randomBytes(300);
    const two = randomBytes(5000);
    const thumb = randomBytes(900);
    const e1: CopyEntry = {
      key: originalKey(loc, newId()),
      sha256: sha(one),
      bytes: one.length,
      contentType: 'image/jpeg',
    };
    const e2: CopyEntry = {
      key: originalKey(loc, newId()),
      sha256: sha(two),
      bytes: two.length,
      contentType: 'application/pdf',
    };
    const d1: CopyEntry = {
      key: derivativeKey(newId(), 'thumb'),
      sha256: null,
      bytes: thumb.length,
      contentType: 'image/jpeg',
    };
    await putBytes(from, a, e1.key, one);
    await putBytes(from, a, e2.key, two);
    await putBytes(from, a, d1.key, thumb);
    const tmpDir = path.join(a, 'tmp');

    const dry = await copyBlobs({ from, to, entries: [e1, e2, d1], tmpDir, dryRun: true });
    expect(dry).toMatchObject({ total: 3, copied: 3, present: 0, problems: [] });
    expect(await to.exists(e1.key)).toBe(false);

    const first = await copyBlobs({ from, to, entries: [e1, e2, d1], tmpDir });
    expect(first).toMatchObject({ copied: 3, present: 0, replaced: 0, problems: [] });
    expect(first.bytesCopied).toBe(one.length + two.length + thumb.length);
    expect((await readAll(to, e2.key)).equals(two)).toBe(true);

    // Resumable: nothing to do the second time.
    expect(await copyBlobs({ from, to, entries: [e1, e2, d1], tmpDir })).toMatchObject({
      copied: 0,
      present: 3,
    });

    // A corrupted destination object (an original, and a derivative with no recorded hash).
    await to.delete(e1.key);
    await putBytes(to, b, e1.key, randomBytes(one.length));
    await to.delete(d1.key);
    await putBytes(to, b, d1.key, randomBytes(thumb.length));
    const again = await copyBlobs({ from, to, entries: [e1, e2, d1], tmpDir });
    expect(again).toMatchObject({ copied: 2, replaced: 2, present: 1, problems: [] });
    expect((await readAll(to, e1.key)).equals(one)).toBe(true);
    expect((await readAll(to, d1.key)).equals(thumb)).toBe(true);

    // A row with no blob behind it, and a source whose bytes aren't the recorded ones.
    const gone: CopyEntry = { ...e1, key: originalKey(loc, newId()) };
    const bad: CopyEntry = { ...e2, key: originalKey(loc, newId()) };
    await putBytes(from, a, bad.key, randomBytes(two.length));
    const problems = await copyBlobs({ from, to, entries: [gone, bad], tmpDir });
    expect(problems.copied).toBe(0);
    expect(problems.problems).toEqual(
      [
        { key: gone.key, reason: 'missing' },
        { key: bad.key, reason: 'source_mismatch' },
      ].sort((x, y) => x.key.localeCompare(y.key)),
    );
    expect(await to.exists(bad.key)).toBe(false);

    const verified = await verifyBlobs({ store: to, entries: [e1, e2, d1, gone] });
    expect(verified).toEqual({ total: 4, ok: 3, problems: [{ key: gone.key, reason: 'missing' }] });
  });
});

// ---------------------------------------------------------------------------------------------
// The CLI against RustFS (compose.dev.yaml's `s3` profile, port 9452), skipped with a warning when
// nothing answers, unless KEPT_TEST_S3_URL is set (as storage/s3.test.ts does). Its own bucket,
// emptied and removed afterwards.

const S3_URL = process.env.KEPT_TEST_S3_URL || 'http://localhost:9452';
const S3_REQUIRED = Boolean(process.env.KEPT_TEST_S3_URL);
const S3_KEY_ID = process.env.KEPT_TEST_S3_ACCESS_KEY_ID || 'kept-dev';
const S3_SECRET = process.env.KEPT_TEST_S3_SECRET_ACCESS_KEY || 'kept-dev-secret';
const live = await fetch(S3_URL, { signal: AbortSignal.timeout(2_000) }).then(
  () => true,
  () => false,
);
if (!live && !S3_REQUIRED) {
  process.stderr.write(
    `\n! storage/copy.test.ts: the RustFS tests are SKIPPED (nothing at ${S3_URL}; docker compose -f compose.dev.yaml --profile s3 up -d --wait)\n\n`,
  );
  it.skip(`kept admin storage against a real S3 store: nothing at ${S3_URL}`, () => {});
}

describe.skipIf(!live && !S3_REQUIRED)(`kept admin storage, local ⇄ ${S3_URL}`, () => {
  const bucket = `kept-test-copy-${randomBytes(6).toString('hex')}`;
  const s3 = new S3BlobStore({
    bucket,
    region: 'us-east-1',
    endpoint: S3_URL,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_KEY_ID, secretAccessKey: S3_SECRET },
  });
  let db: TestDb;
  let dataDir: string;
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  const envFor = (storage: 'local' | 's3', dir: string) => ({
    KEPT_OWNER_DATABASE_URL: db.urls.owner,
    KEPT_STORAGE: storage,
    KEPT_DATA_DIR: dir,
    KEPT_S3_ENDPOINT: S3_URL,
    KEPT_S3_REGION: 'us-east-1',
    KEPT_S3_BUCKET: bucket,
    KEPT_S3_ACCESS_KEY_ID: S3_KEY_ID,
    KEPT_S3_SECRET_ACCESS_KEY: S3_SECRET,
    KEPT_S3_FORCE_PATH_STYLE: 'true',
  });
  const originals = new Map<string, Buffer>();

  beforeAll(async () => {
    if (!live) throw new Error(`KEPT_TEST_S3_URL is set but nothing answers at ${S3_URL}`);
    db = await testDb();
    await db.reset();
    dataDir = await newDir();
    const store = localStore(dataDir);
    const t = await seedTenant(db, 'ibrahim');
    await ownerTx(db, async (c) => {
      for (const [i, size] of [1200, 64_000, 7].entries()) {
        const id = newId();
        const key = originalKey(t.locationId, id);
        const bytes = randomBytes(size);
        originals.set(key, bytes);
        await putBytes(store, dataDir, key, bytes);
        await c.query(
          `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                     derivative_state, created_by)
           VALUES ($1, $2, $3, $4, $5, 'application/pdf', 'document', 'not_applicable', $6)`,
          [id, t.locationId, key, sha(bytes), bytes.length, t.userId],
        );
        if (i === 0) {
          const dkey = derivativeKey(id, 'thumb');
          const thumb = randomBytes(800);
          originals.set(dkey, thumb);
          await putBytes(store, dataDir, dkey, thumb);
          await c.query(
            `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key,
                                                  width, height, bytes)
             VALUES ($1, 'thumb', $2, $3, 32, 24, $4)`,
            [id, t.locationId, dkey, thumb.length],
          );
        }
      }
    });
  });

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    if (!live) return;
    try {
      for (;;) {
        const listed = await s3.client.send(new ListObjectsV2Command({ Bucket: bucket }));
        const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length === 0) break;
        await s3.client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
        );
      }
      await s3.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      s3.destroy();
    }
  });

  it('lists every referenced blob once', async () => {
    const entries = await ownerTx(db, (c) => blobsToCopy(c));
    expect(entries.map((e) => e.key).sort()).toEqual([...originals.keys()].sort());
  });

  it('copies local → S3 (creating the bucket), verifies it, and is a no-op the second time', async () => {
    expect(
      await storageCopyCommand(envFor('local', dataDir), { to: 's3', dryRun: true }, print),
    ).toBe(0);
    expect(lines.join('\n')).toContain('4 to copy');
    lines.length = 0;
    expect(await storageCopyCommand(envFor('local', dataDir), { to: 's3' }, print)).toBe(0);
    expect(lines.join('\n')).toContain('4 copied');
    for (const [key, bytes] of originals) expect((await readAll(s3, key)).equals(bytes)).toBe(true);
    expect(await storageVerifyCommand(envFor('local', dataDir), { store: 's3' }, print)).toBe(0);
    lines.length = 0;
    expect(await storageCopyCommand(envFor('local', dataDir), { to: 's3' }, print)).toBe(0);
    expect(lines.join('\n')).toContain('0 copied');
    expect(lines.join('\n')).toContain('4 already there');
  });

  it('copies a corrupted S3 object over, and refuses to copy to the store already in use', async () => {
    // An original: a derivative records only its size, so same-sized junk passes verify (it is
    // still copied over when the source is local and the hashes differ).
    const [key, bytes] = [...originals.entries()].filter(([k]) => k.startsWith('f/'))[1] as [
      string,
      Buffer,
    ];
    const junk = randomBytes(bytes.length);
    await s3.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: junk, ContentLength: junk.length }),
    );
    expect(await storageVerifyCommand(envFor('local', dataDir), { store: 's3' }, print)).toBe(1);
    expect(lines.join('\n')).toContain(`mismatch: ${key}`);
    expect(await storageCopyCommand(envFor('local', dataDir), { to: 's3' }, print)).toBe(0);
    expect(lines.join('\n')).toContain('1 over different bytes');
    expect((await readAll(s3, key)).equals(bytes)).toBe(true);
    await expect(storageCopyCommand(envFor('s3', dataDir), { to: 's3' }, print)).rejects.toThrow(
      /already s3/,
    );
  });

  it('copies S3 → a fresh local store, byte-identical', async () => {
    const back = await newDir();
    expect(await storageCopyCommand(envFor('s3', back), { to: 'local' }, print)).toBe(0);
    for (const key of originals.keys()) {
      const onDisk = await readFile(path.join(back, 'blobs', key));
      expect(onDisk.equals(originals.get(key) as Buffer)).toBe(true);
    }
    expect(await storageVerifyCommand(envFor('s3', back), { store: 'local' }, print)).toBe(0);
  });
});
