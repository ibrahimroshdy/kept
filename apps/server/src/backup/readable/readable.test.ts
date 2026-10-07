import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../test/app.js';
import { type TestDb, testDb } from '../../../test/db.js';
import { fixture, type TestFiles, testFiles, upload } from '../../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../../test/people.js';
import { type TestPgTools, testPgTools } from '../../../test/pg-tools.js';
import { asOwner } from '../../../test/tenancy.js';
import {
  builtinType,
  createLocation,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../../test/things.js';
import { fixedSecretKeys, keyringOf } from '../../crypto/keyring.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { runSnapshot } from '../nightly.js';
import { FakeRestic } from '../restic/fake.js';
import type { Restic } from '../restic/restic.js';
import { ResticCli } from '../restic/run.js';
import { MARKER_FILE } from './cache.js';
import { type ReadableTreeDeps, readableCopy, writeReadableTree } from './run.js';

// Step 8, T6 (D159; Q10, Q11): every location's readable copy in the nightly snapshot, written as
// its owner sees it. Against a real database and file store; restic is the fake unless
// KEPT_TEST_RESTIC=1 and a binary is there (KEPT_RESTIC_BIN, else `restic` on PATH).

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const SECRET = 'SECRET-COMBINATION-8812';
const BACKUP_PASSWORD = 'a backup password, long enough';
const RESTIC_BIN = process.env.KEPT_RESTIC_BIN || 'restic';
const REAL =
  process.env.KEPT_TEST_RESTIC === '1' &&
  spawnSync(RESTIC_BIN, ['version'], { stdio: 'ignore' }).status === 0;

let db: TestDb;
let files: TestFiles;
let t: TestApp;
let ibrahim: Person;
let alfred: Person;
let talia: Person;
let home: Loc;
let family: Loc;
let tv: string;
let photoId: string;
let receiptId: string;
let scratch: string;

function depsFor(more: Partial<ReadableTreeDeps> = {}): ReadableTreeDeps {
  return {
    ownerUrl: db.urls.owner,
    pools: db.pools,
    files,
    storage: 'local',
    publicUrl: t.publicUrl,
    log: { info: () => {}, error: () => {} },
    pdf: false,
    ...more,
  };
}

/** Every regular file under `dir`, relative, with its mtime and inode. */
async function listing(dir: string): Promise<Map<string, { mtime: number; ino: number }>> {
  const out = new Map<string, { mtime: number; ino: number }>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const s = await stat(full);
        out.set(path.relative(dir, full), { mtime: s.mtimeMs, ino: s.ino });
      }
    }
  };
  await walk(dir);
  return out;
}

async function bytesUnder(dir: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const rel of (await listing(dir)).keys()) out.push(await readFile(path.join(dir, rel)));
  return out;
}

/** A blob store that counts reads, and has no local paths (as S3 storage). */
function countingStore(inner: BlobStore): BlobStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    put: (k, f, o) => inner.put(k, f, o),
    stream: async (k, r) => {
      reads.push(k);
      return inner.stream(k, r);
    },
    delete: (k) => inner.delete(k),
    exists: (k) => inner.exists(k),
    signedUrl: (k, o) => inner.signedUrl(k, o),
  };
}

async function renameThing(id: string, name: string): Promise<void> {
  const got = ok(await call(t, `/api/v1/things/${id}`, { as: ibrahim })) as {
    rowVersion?: unknown;
  };
  const res = await call(t, `/api/v1/things/${id}`, {
    as: ibrahim,
    method: 'PATCH',
    body: { name },
    headers: { 'if-match': String(got.rowVersion) },
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
}

async function uploadAndAttach(
  who: Person,
  loc: Loc,
  thingId: string,
  bytes: Buffer,
  role: string,
  opts: { cls?: string; contentType?: string } = {},
): Promise<string> {
  const up = await upload(t, who, loc.id, bytes, opts);
  expect(up.statusCode, up.body).toBe(201);
  const fileId = (up.json() as { id: string }).id;
  ok(
    await call(t, '/api/v1/attachments', {
      as: who,
      body: { locationId: loc.id, fileId, subject: { thingId }, role },
    }),
    201,
  );
  return fileId;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, {
    files,
    secretKeys: fixedSecretKeys(
      keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }),
    ),
  });
  ibrahim = await person(t, db, 'ibrahim');
  alfred = await person(t, db, 'alfred');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, alfred, 'ألفريد');
  await own(
    db,
    `UPDATE public.user_profiles SET locale = 'ar', digits = 'eastern' WHERE user_id = $1`,
    [alfred.userId],
  );
  home = await createLocation(t, db, ibrahim, 'complete', 'Home');
  family = await createLocation(t, db, alfred, 'household', 'بيت العائلة');
  await join(db, home.id, talia.userId, 'viewer');
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );

  const study = await place(db, home, 'Study');
  const safe = ok(
    await call(t, '/api/v1/things', {
      as: ibrahim,
      body: {
        locationId: home.id,
        placeId: study,
        name: 'Safe',
        typeId: await builtinType(db, 'safe'),
      },
    }),
    201,
  ).id;
  const put = await call(t, `/api/v1/things/${safe}/secrets/combination`, {
    as: ibrahim,
    method: 'PUT',
    body: { value: SECRET },
  });
  expect(put.statusCode, put.body).toBeLessThan(300);
  tv = ok(
    await call(t, '/api/v1/things', {
      as: ibrahim,
      body: {
        locationId: home.id,
        placeId: study,
        name: 'Television',
        purchase: { purchasedOn: '2024-03-12', currency: 'EGP', price: '25000' },
      },
    }),
    201,
  ).id;
  photoId = await uploadAndAttach(ibrahim, home, tv, await fixture('photo.jpg'), 'photo');
  receiptId = await uploadAndAttach(ibrahim, home, tv, await fixture('doc.pdf'), 'receipt', {
    cls: 'document',
    contentType: 'application/pdf',
  });
  ok(
    await call(t, '/api/v1/things', {
      as: alfred,
      body: { locationId: family.id, placeId: family.unplacedId, name: 'ثلاجة' },
    }),
    201,
  );
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-readable-'));
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('the readable tree', () => {
  it('writes every location as its owner sees it, links the files, and keeps unchanged ones', async () => {
    const dir = path.join(files.dir, 'backup', 'readable');
    const result = await writeReadableTree(depsFor(), dir);
    expect(result.failed).toEqual([]);
    const byId = new Map(result.locations.map((l) => [l.locationId, l]));
    expect(byId.get(home.id)).toMatchObject({ state: 'written', things: 2, owner: 'Ibrahim' });
    expect(byId.get(family.id)).toMatchObject({ state: 'written', things: 1 });
    // Every Personal location too.
    expect(byId.has(ibrahim.personalLocationId)).toBe(true);

    // The top index lists them, linking each copy; the README says how to open it.
    const top = await readFile(path.join(dir, 'index.html'), 'utf8');
    expect(top).toContain(`href="${home.id}/index.html"`);
    expect(top).toContain('<bdi>بيت العائلة</bdi>');
    expect(top).not.toMatch(/<script|https?:\/\//);
    expect(await readFile(path.join(dir, 'README.txt'), 'utf8')).toContain('/backup/readable');

    // Home: the owner's view, so the price shows (a viewer's wouldn't; Talia's view never applies).
    const homeIndex = await readFile(path.join(dir, home.id, 'index.html'), 'utf8');
    expect(homeIndex).toContain('Television');
    expect(homeIndex).toMatch(/25,000/);
    expect(homeIndex).toContain(`href="files/${photoId}.jpg"`);
    expect(homeIndex).toContain(`href="files/${receiptId}.pdf"`);
    // Alfred's copy is Arabic, right to left, in his digits.
    const familyIndex = await readFile(path.join(dir, family.id, 'index.html'), 'utf8');
    expect(familyIndex).toContain('dir="rtl"');
    expect(familyIndex).toContain('ثلاجة');

    // Local storage: each original is a hard link to its blob (no extra space).
    const photoBlob = await own<{ storage_key: string }>(
      db,
      'SELECT storage_key FROM public.files WHERE id = $1',
      [photoId],
    );
    const blobPath = path.join(files.dir, 'blobs', photoBlob[0]?.storage_key as string);
    const linked = await stat(path.join(dir, home.id, 'files', `${photoId}.jpg`));
    expect(linked.ino).toBe((await stat(blobPath)).ino);

    // Never a secret: a byte search of the whole tree.
    for (const bytes of await bytesUnder(dir)) expect(bytes.includes(SECRET)).toBe(false);

    // Nothing changed: no file in any location is rewritten.
    const before = await listing(dir);
    const again = await writeReadableTree(depsFor(), dir);
    expect(again.locations.every((l) => l.state === 'unchanged')).toBe(true);
    expect(again.locations.find((l) => l.locationId === home.id)?.things).toBe(2);
    const after = await listing(dir);
    for (const [rel, s] of before) {
      if (rel === 'index.html') continue;
      expect(after.get(rel), rel).toEqual(s);
    }

    // A renamed thing rewrites its location only.
    await renameThing(tv, 'Television (living room)');
    const third = await writeReadableTree(depsFor(), dir);
    const states = new Map(third.locations.map((l) => [l.locationId, l.state]));
    expect(states.get(home.id)).toBe('written');
    expect(states.get(family.id)).toBe('unchanged');
    const final = await listing(dir);
    for (const [rel, s] of before) {
      if (rel.startsWith(`${family.id}/`)) expect(final.get(rel), rel).toEqual(s);
    }
    expect(await readFile(path.join(dir, home.id, 'index.html'), 'utf8')).toContain(
      'Television (living room)',
    );
    expect(final.has(`${home.id}/${MARKER_FILE}`)).toBe(true);
  });

  it('with S3 storage downloads receipts as originals and photos as their display copy, each once', async () => {
    const store = countingStore(files.blobs);
    const dir = path.join(scratch, 's3-tree');
    const deps = depsFor({ storage: 's3', files: { ...files, blobs: store } });
    await writeReadableTree(deps, dir, { locationId: home.id });
    const homeIndex = await readFile(path.join(dir, home.id, 'index.html'), 'utf8');
    expect(homeIndex).toContain(`href="files/${photoId}-display.jpg"`);
    expect(homeIndex).toContain(`href="files/${receiptId}.pdf"`);
    const names = await readdir(path.join(dir, home.id, 'files'));
    expect(names.sort()).toEqual([`${photoId}-display.jpg`, `${receiptId}.pdf`].sort());
    const receiptKey = (
      await own<{ storage_key: string }>(db, 'SELECT storage_key FROM public.files WHERE id = $1', [
        receiptId,
      ])
    )[0]?.storage_key as string;
    expect(store.reads.filter((k) => k === receiptKey)).toHaveLength(1);

    // A change rewrites the location; the receipt comes from last night's tree, not the bucket.
    await renameThing(tv, 'Television');
    const second = await writeReadableTree(deps, dir, { locationId: home.id });
    expect(second.locations[0]?.state).toBe('written');
    expect(store.reads.filter((k) => k === receiptKey)).toHaveLength(1);
  });

  it('lists a location being deleted without a copy, and removes trees of locations that are gone', async () => {
    const dir = path.join(scratch, 'deleted-tree');
    const gone = path.join(dir, '0190a1b2-0000-7000-8000-000000000000');
    await writeReadableTree(depsFor(), dir);
    await writeFile(path.join(dir, 'stray.txt'), 'kept');
    await import('node:fs/promises').then((fs) => fs.mkdir(gone, { recursive: true }));
    await own(
      db,
      `UPDATE public.locations SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`,
      [family.id],
    );
    try {
      const result = await writeReadableTree(depsFor(), dir);
      expect(result.locations.find((l) => l.locationId === family.id)?.state).toBe('deleted');
      expect(result.failed).toEqual([]);
      await expect(stat(path.join(dir, family.id))).rejects.toThrow();
      await expect(stat(gone)).rejects.toThrow();
      expect(await readFile(path.join(dir, 'index.html'), 'utf8')).toContain('Being deleted');
    } finally {
      await own(
        db,
        'UPDATE public.locations SET deleted_at = NULL, purge_after = NULL WHERE id = $1',
        [family.id],
      );
    }
  });
});

describe('in the nightly snapshot', () => {
  let pgt: TestPgTools;
  beforeAll(async () => {
    const major = await asOwner(db, async (c) => {
      const { rows } = await c.query<{ n: number }>(
        `SELECT current_setting('server_version_num')::int / 10000 AS n`,
      );
      return rows[0]?.n ?? 0;
    });
    pgt = await testPgTools(major);
  });

  const settingsFor = (dir: string) => ({
    target: { kind: 'dir' as const, path: dir },
    password: BACKUP_PASSWORD,
    time: '02:30',
    keep: { daily: 7, weekly: 4, monthly: 6 },
    description: `directory ${dir}`,
    locked: true,
  });

  it.each([
    ['the fake', false],
    ['the real binary', true],
  ] as const)('holds the readable copy of every location (%s)', async (_label, real) => {
    if (real && !REAL) return;
    const restic: Restic = real
      ? new ResticCli({ bin: RESTIC_BIN, cacheDir: path.join(scratch, 'restic-cache') })
      : new FakeRestic();
    const target = path.join(scratch, real ? 'repo-real' : 'repo-fake');
    const run = await runSnapshot(
      {
        ownerUrl: db.urls.owner,
        restic,
        settings: settingsFor(target),
        dataDir: files.dir,
        storage: 'local',
        blobs: files.blobs,
        pgTools: pgt.tools,
        readable: readableCopy(depsFor()),
      },
      { kind: 'manual', acceptSize: true },
    );
    expect(run.status, JSON.stringify(run)).toBe('ok');
    expect(run.readableLocations).toBeGreaterThanOrEqual(5);
    expect(run.readableBytes).toBeGreaterThan(0);
    const repo = {
      location: path.join(target, 'restic'),
      env: { RESTIC_PASSWORD: BACKUP_PASSWORD },
      description: '',
    };
    const nodes = (await restic.ls(repo, run.snapshotId as string))
      .filter((n) => n.type === 'file')
      .map((n) => n.path);
    expect(nodes).toEqual(
      expect.arrayContaining([
        '/backup/readable/index.html',
        '/backup/readable/README.txt',
        `/backup/readable/${home.id}/index.html`,
        `/backup/readable/${home.id}/things.csv`,
        `/backup/readable/${home.id}/files/${photoId}.jpg`,
        `/backup/readable/${family.id}/index.html`,
      ]),
    );
  });

  it('a location that fails makes the run a warning, listed as not included tonight', async () => {
    const failing: BlobStore = {
      ...files.blobs,
      put: (k, f, o) => files.blobs.put(k, f, o),
      delete: (k) => files.blobs.delete(k),
      exists: (k) => files.blobs.exists(k),
      signedUrl: (k, o) => files.blobs.signedUrl(k, o),
      stream: async (): Promise<Readable> => {
        throw Object.assign(new Error('the bucket is down'), { code: 'ECONNRESET' });
      },
    };
    const dir = path.join(scratch, 'failing');
    const run = await runSnapshot(
      {
        ownerUrl: db.urls.owner,
        restic: new FakeRestic(),
        settings: settingsFor(path.join(scratch, 'repo-failing')),
        dataDir: files.dir,
        storage: 'local',
        blobs: files.blobs,
        pgTools: pgt.tools,
        readable: async (_dir) =>
          readableCopy(depsFor({ storage: 's3', files: { ...files, blobs: failing } }))(dir),
      },
      { kind: 'manual', acceptSize: true },
    );
    expect(run).toMatchObject({ status: 'warning', error: 'readable_incomplete' });
    expect(run.detail).toMatchObject({ readableFailed: 1 });
    const top = await readFile(path.join(dir, 'index.html'), 'utf8');
    expect(top).toContain('Not included tonight (file_error)');
    await expect(stat(path.join(dir, home.id))).rejects.toThrow();
  });
});
