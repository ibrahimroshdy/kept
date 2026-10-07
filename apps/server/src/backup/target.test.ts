import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertBackupName, type BackupTarget, LocalDirTarget, S3Target } from './target.js';

// A bucket round trip is milliseconds alone, seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// T31c: the two backup targets hold the same names and behave the same (backup/target.ts). The
// bucket half runs against RustFS (compose.dev.yaml's `s3` profile) like storage/s3.test.ts:
// required when KEPT_TEST_S3_URL is set (ci-local), else skipped loudly when nothing answers.

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-backup-target-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function localFile(content: string | Buffer): Promise<string> {
  const file = path.join(scratch, `${randomBytes(6).toString('hex')}.part`);
  await writeFile(file, content);
  return file;
}

function targetContract(name: string, make: () => Promise<BackupTarget>) {
  describe(`${name} (backup target contract)`, () => {
    it('puts, reads, gets, lists and removes by name', async () => {
      const target = await make();
      const bytes = randomBytes(2048);
      await target.put('runs/20260927T023000Z-abc123/db.dump', await localFile(bytes));
      await target.put('blobs/f/a/b', await localFile('blob'));
      expect(await target.exists('runs/20260927T023000Z-abc123/db.dump')).toBe(true);
      expect(await target.exists('runs/20260927T023000Z-abc123/manifest.json')).toBe(false);
      expect((await target.read('runs/20260927T023000Z-abc123/db.dump')).equals(bytes)).toBe(true);
      const out = path.join(scratch, 'got');
      await target.get('blobs/f/a/b', out);
      expect(await readFile(out, 'utf8')).toBe('blob');
      expect(await target.list('runs/')).toEqual(['runs/20260927T023000Z-abc123/db.dump']);
      expect(await target.list('blobs/')).toEqual(['blobs/f/a/b']);
      await target.remove('blobs/f/a/b');
      expect(await target.list('blobs/')).toEqual([]);
      expect(await target.list('nothing/')).toEqual([]);
    });

    it('refuses names Kept did not build', async () => {
      const target = await make();
      const file = await localFile('x');
      for (const bad of ['../escape', 'runs/../../x', '/abs', 'runs/a b', 'runs//x', '']) {
        await expect(target.put(bad, file), bad).rejects.toThrow('not a backup name');
      }
    });
  });
}

describe('assertBackupName', () => {
  it('takes run and blob names, and nothing with dots for directories', () => {
    expect(assertBackupName('runs/20260927T023000Z-abc123/manifest.json')).toBeTruthy();
    expect(assertBackupName('blobs/d/0192/display.jpg')).toBeTruthy();
    expect(() => assertBackupName('blobs/../x')).toThrow();
    expect(() => assertBackupName('blobs/./x')).toThrow();
  });
});

targetContract(
  'LocalDirTarget',
  async () => new LocalDirTarget(await mkdtemp(path.join(scratch, 'dir-'))),
);

describe('LocalDirTarget modes', () => {
  it('writes files 0600 and the directories it makes 0700', async () => {
    const root = path.join(scratch, 'modes', 'backups');
    const target = new LocalDirTarget(root);
    await target.put('runs/20260927T023000Z-abc123/db.dump', await localFile('dump'));
    const mode = async (p: string) => (await stat(path.join(root, p))).mode & 0o777;
    expect(await mode('runs/20260927T023000Z-abc123/db.dump')).toBe(0o600);
    expect(await mode('runs/20260927T023000Z-abc123')).toBe(0o700);
    expect(await mode('runs')).toBe(0o700);
    expect(await mode('.')).toBe(0o700);
    // An emptied run's directory goes with its last file.
    await target.remove('runs/20260927T023000Z-abc123/db.dump');
    expect(await target.list('runs/')).toEqual([]);
    await expect(stat(path.join(root, 'runs/20260927T023000Z-abc123'))).rejects.toThrow();
  });
});

const S3_URL = process.env.KEPT_TEST_S3_URL || 'http://localhost:9452';
const S3_REQUIRED = Boolean(process.env.KEPT_TEST_S3_URL);
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}
const live = await reachable(S3_URL);
const SKIP_REASON = `no S3 store at ${S3_URL}; start it with \`docker compose -f compose.dev.yaml --profile s3 up -d --wait\``;
if (!live && !S3_REQUIRED) {
  process.stderr.write(
    `\n${'!'.repeat(78)}\n! backup/target.test.ts: the S3 target tests are SKIPPED.\n! ${SKIP_REASON}\n${'!'.repeat(78)}\n\n`,
  );
  it.skip(`S3Target against a real store: ${SKIP_REASON}`, () => {});
}

describe.skipIf(!live && !S3_REQUIRED)(`S3Target against ${S3_URL}`, () => {
  const bucket = `kept-backup-test-${randomBytes(6).toString('hex')}`;
  const options = {
    bucket,
    region: 'us-east-1',
    endpoint: S3_URL,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.KEPT_TEST_S3_ACCESS_KEY_ID || 'kept-dev',
      secretAccessKey: process.env.KEPT_TEST_S3_SECRET_ACCESS_KEY || 'kept-dev-secret',
    },
  };
  let prefixes = 0;
  const first = new S3Target({ ...options, prefix: 'setup/' });

  beforeAll(async () => {
    if (!live) throw new Error(`KEPT_TEST_S3_URL is set but nothing answers at ${S3_URL}`);
    await first.client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    if (!live) return;
    for (;;) {
      const listed = await first.client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length === 0) break;
      await first.client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
      );
    }
    await first.client.send(new DeleteBucketCommand({ Bucket: bucket }));
  });

  // A fresh prefix per test: each starts from an empty "directory".
  targetContract('S3Target', async () => {
    prefixes += 1;
    return new S3Target({ ...options, prefix: `kept-backups/t${prefixes}/` });
  });
});
