import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resticContract } from '../../../test/restic-contract.js';
import { FakeRestic } from './fake.js';
import { ResticError, type ResticRepo, scrubSecrets } from './restic.js';
import { ResticCli } from './run.js';

// The Restic contract on the in-memory fake (step-8 plan T2), and on the real wrapper (run.ts,
// T5) under KEPT_TEST_RESTIC=1, with the binary KEPT_RESTIC_BIN names (else `restic` on PATH):
// the pinned release R1 recorded, 0.19.1. Each repository is a directory in a scratch folder.

let counter = 0;
const fakeRepo = (password: string, same?: ResticRepo): ResticRepo => ({
  location: same?.location ?? `/fake/repo-${++counter}`,
  env: { RESTIC_PASSWORD: password },
  description: 'directory /fake',
});

resticContract('FakeRestic', async () => {
  const restic = new FakeRestic('0.0.0-fake');
  return { restic, makeRepo: async (password, same) => fakeRepo(password, same) };
});

const REAL = process.env.KEPT_TEST_RESTIC === '1';
// Forty-one real backups for the retention case: tens of seconds, more on a loaded machine.
if (REAL) vi.setConfig({ testTimeout: 300_000 });
if (!REAL) it.skip('ResticCli: the Restic contract (set KEPT_TEST_RESTIC=1)', () => {});
if (REAL) {
  resticContract('ResticCli', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kept-restic-real-'));
    let n = 0;
    const restic = new ResticCli({
      bin: process.env.KEPT_RESTIC_BIN || 'restic',
      cacheDir: path.join(root, 'cache'),
    });
    return {
      restic,
      makeRepo: async (password, same) => ({
        location: same?.location ?? path.join(root, `repo-${++n}`),
        env: { RESTIC_PASSWORD: password },
        description: 'directory (test)',
      }),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  });
}

// The same contract against an S3 repository on the dev RustFS (compose profile `s3`, port 9452,
// or KEPT_TEST_S3_URL), as R1 ran it: path-style lookup, the keys in AWS_* only. Its own bucket,
// emptied and removed afterwards. Skipped when nothing answers there.
const S3_URL = process.env.KEPT_TEST_S3_URL || 'http://localhost:9452';
const s3Live = REAL
  ? await fetch(S3_URL, { signal: AbortSignal.timeout(2_000) }).then(
      () => true,
      () => false,
    )
  : false;
if (REAL && !s3Live) it.skip(`ResticCli on S3: nothing answers at ${S3_URL}`, () => {});
if (REAL && s3Live) {
  resticContract('ResticCli on S3 (RustFS)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kept-restic-s3-'));
    const bucket = `kept-restic-test-${Date.now().toString(36)}`;
    const credentials = {
      accessKeyId: process.env.KEPT_TEST_S3_ACCESS_KEY_ID || 'kept-dev',
      secretAccessKey: process.env.KEPT_TEST_S3_SECRET_ACCESS_KEY || 'kept-dev-secret',
    };
    let n = 0;
    const restic = new ResticCli({
      bin: process.env.KEPT_RESTIC_BIN || 'restic',
      cacheDir: path.join(root, 'cache'),
    });
    return {
      restic,
      makeRepo: async (password, same) => ({
        location: same?.location ?? `s3:${S3_URL}/${bucket}/repo-${++n}/restic`,
        env: {
          RESTIC_PASSWORD: password,
          AWS_ACCESS_KEY_ID: credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        },
        options: { 's3.region': 'us-east-1', 's3.bucket-lookup': 'path' },
        description: `S3 bucket ${bucket} (test)`,
      }),
      cleanup: async () => {
        const { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } =
          await import('@aws-sdk/client-s3');
        const client = new S3Client({
          region: 'us-east-1',
          endpoint: S3_URL,
          forcePathStyle: true,
          credentials,
        });
        try {
          for (;;) {
            const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
            const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
            if (keys.length === 0) break;
            await client.send(
              new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
            );
          }
          await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        } catch {
          // Never made (a failure before the first init).
        } finally {
          client.destroy();
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  });
}

describe('FakeRestic: its test hooks', () => {
  const PASSWORD = 'a backup password of some length';

  it('fails the next command with a scrubbed message, then works again', async () => {
    const restic = new FakeRestic();
    const repo = fakeRepo(PASSWORD);
    await restic.init(repo);
    restic.failNext('unreachable', `Fatal: s3 says no to ${PASSWORD}`);
    const err = await restic.snapshots(repo).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResticError);
    expect(err).toMatchObject({ reason: 'unreachable' });
    expect((err as Error).message).not.toContain(PASSWORD);
    expect((err as Error).message).toContain('[redacted]');
    expect(await restic.snapshots(repo)).toEqual([]);
  });

  it('refuses a backup or a forget while the repository is locked, until unlocked', async () => {
    const restic = new FakeRestic();
    const repo = fakeRepo(PASSWORD);
    await restic.init(repo);
    restic.lock(repo.location);
    const dir = await mkdtemp(path.join(tmpdir(), 'kept-fake-restic-'));
    try {
      await mkdir(path.join(dir, 'backup'));
      await writeFile(path.join(dir, 'backup', 'a'), 'a');
      const opts = { paths: [path.join(dir, 'backup')], tags: ['kept'] };
      await expect(restic.backup(repo, opts)).rejects.toMatchObject({ reason: 'locked' });
      await restic.unlock(repo);
      await expect(restic.backup(repo, opts)).resolves.toMatchObject({ filesNew: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records each command with the names of its environment, never the values', async () => {
    const restic = new FakeRestic();
    const repo = fakeRepo(PASSWORD);
    await restic.init(repo);
    await restic.snapshots(repo);
    expect(restic.calls).toEqual([
      { command: 'init', location: repo.location, envNames: ['RESTIC_PASSWORD'] },
      { command: 'snapshots', location: repo.location, envNames: ['RESTIC_PASSWORD'] },
    ]);
    expect(JSON.stringify(restic.calls)).not.toContain(PASSWORD);
  });
});

describe('scrubSecrets', () => {
  it('replaces every environment value, longest first, and leaves short ones', () => {
    const repo = {
      env: { RESTIC_PASSWORD: 'hunter2hunter2', AWS_SECRET_ACCESS_KEY: 'hunter2', X: 'ab' },
    };
    expect(scrubSecrets('pw hunter2hunter2 key hunter2 ab', repo)).toBe(
      'pw [redacted] key [redacted] ab',
    );
  });
});
