import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { ownerTx, seedTenant } from '../../test/tenancy.js';
import type { SystemJob } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { BlobStore } from '../storage/blob-store.js';
import { LocalBlobStore } from '../storage/local.js';
import { createUrlSigner } from '../storage/signed-url.js';
import { runPurge, trashJobs } from './jobs.js';

// Task 21: the `purge` system job end to end (D149, D161, D162; §3.3). Fixtures are written as
// kept_owner; the job runs as it does in the worker, on kept_system through the maintenance
// doors of migration 0022, and deletes the blobs they hand back from a real local blob store.

let db: TestDb;
let dir: string;
let blobs: LocalBlobStore;
const logs: { level: 'info' | 'error'; obj: object; msg: string }[] = [];
const log = {
  info: (obj: object, msg: string) => void logs.push({ level: 'info', obj, msg }),
  error: (obj: object, msg: string) => void logs.push({ level: 'error', obj, msg }),
};

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

type Loc = { id: string; unplaced: string; userId: string };

async function location(name: string): Promise<Loc> {
  const t = await seedTenant(db, name.toLowerCase().replaceAll(' ', '-'), { name });
  return { id: t.locationId, unplaced: t.unplacedId, userId: t.userId };
}

async function thing(loc: Loc, name: string, trashedDaysAgo: number | null): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, deleted_at, trash_batch_id)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE uuidv7() END)`,
    [id, loc.id, loc.unplaced, name, trashedDaysAgo],
  );
  return id;
}

/** A stored file of `loc` with a blob, created `daysAgo`, attached to `thingId` if given. */
async function file(loc: Loc, daysAgo: number, thingId?: string): Promise<string> {
  const id = newId();
  const key = `f/${loc.id}/${id}`;
  const bytes = randomBytes(64);
  const tmp = path.join(dir, `${id}.bin`);
  await writeFile(tmp, bytes);
  await blobs.put(key, tmp, { contentType: 'application/pdf', bytes: bytes.length });
  await own(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, 'application/pdf', 'document', 'not_applicable', $6,
             now() - make_interval(days => $7::int))`,
    [id, loc.id, key, randomBytes(32).toString('hex'), bytes.length, loc.userId, daysAgo],
  );
  if (thingId) {
    await own(
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
       VALUES ($1, $2, $3, 'document', $4)`,
      [loc.id, id, thingId, loc.userId],
    );
  }
  return key;
}

const exists = async (table: 'things' | 'files' | 'locations', id: string) =>
  (await own(`SELECT 1 FROM public.${table} WHERE id = $1`, [id])).length > 0;

const tombstone = async (locationId: string, id: string) =>
  (
    await own('SELECT 1 FROM public.sync_tombstones WHERE location_id = $1 AND entity_id = $2', [
      locationId,
      id,
    ])
  ).length > 0;

beforeAll(async () => {
  db = await testDb();
  dir = await mkdtemp(path.join(tmpdir(), 'kept-purge-'));
  blobs = new LocalBlobStore({ dataDir: dir, signer: createUrlSigner(randomBytes(32)) });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.reset();
  logs.splice(0);
});

describe('the purge job (T21)', () => {
  it('is scheduled daily at 03:17 UTC with its own policy', () => {
    const jobs = trashJobs({
      pools: db.pools,
      log,
      mailer: { send: async () => {} },
      publicUrl: 'http://kept.test',
    });
    expect(jobs).toEqual([
      expect.objectContaining({
        name: 'purge',
        kind: 'system',
        schedule: '17 3 * * *',
        policy: JOB_POLICIES.purge,
      }),
    ]);
  });

  it('empties the trash after 30 days and deletes the blobs nothing holds any more', async () => {
    const home = await location('Home');
    const old = await thing(home, 'Old kettle', 31);
    const recent = await thing(home, 'Broken lamp', 29);
    const live = await thing(home, 'Toaster', null);
    const oldBlob = await file(home, 2, old);
    const recentBlob = await file(home, 2, recent);
    const liveBlob = await file(home, 2, live);
    // A fresh upload nobody attached yet: kept for a day, in case it is being attached now.
    const freshBlob = await file(home, 0);

    const report = await runPurge({ pools: db.pools, log, blobs });

    expect(report).toMatchObject({ trashed: 1, locations: 0, blobs: 1, failedBlobs: [] });
    expect(await exists('things', old)).toBe(false);
    expect(await tombstone(home.id, old)).toBe(true);
    expect(await blobs.exists(oldBlob)).toBe(false);
    expect(await own('SELECT 1 FROM public.files WHERE storage_key = $1', [oldBlob])).toEqual([]);

    // Trashed 29 days ago: untouched, and so is its file.
    expect(await exists('things', recent)).toBe(true);
    expect(await tombstone(home.id, recent)).toBe(false);
    expect(await blobs.exists(recentBlob)).toBe(true);
    expect(await blobs.exists(liveBlob)).toBe(true);
    expect(await blobs.exists(freshBlob)).toBe(true);
  });

  it('keeps going while a round fills its limit', async () => {
    const home = await location('Home');
    await own(
      `INSERT INTO public.things (location_id, place_id, name, deleted_at, trash_batch_id)
       SELECT $1, $2, 'Box ' || g, now() - interval '40 days', uuidv7()
         FROM generate_series(1, 501) g`,
      [home.id, home.unplaced],
    );
    const report = await runPurge({ pools: db.pools, log, blobs });
    expect(report.trashed).toBe(501);
    expect(await own('SELECT 1 FROM public.things WHERE location_id = $1', [home.id])).toEqual([]);
  });

  it('purges locations past their grace period, with their blobs (D149)', async () => {
    const gone = await location('Old flat');
    const kept = await location('Home');
    const goneBlob = await file(gone, 3, await thing(gone, 'Sofa', null));
    const keptBlob = await file(kept, 3, await thing(kept, 'Chair', null));
    await own(
      `UPDATE public.locations SET deleted_at = now() - interval '31 days',
                                   purge_after = now() - interval '1 day' WHERE id = $1`,
      [gone.id],
    );

    const report = await runPurge({ pools: db.pools, log, blobs });

    expect(report.locations).toBe(1);
    expect(await exists('locations', gone.id)).toBe(false);
    expect(await blobs.exists(goneBlob)).toBe(false);
    expect(await exists('locations', kept.id)).toBe(true);
    expect(await blobs.exists(keptBlob)).toBe(true);
  });

  it('without file storage, empties the trash and leaves files and locations alone', async () => {
    const home = await location('Home');
    const old = await thing(home, 'Old kettle', 31);
    const blob = await file(home, 2, old);
    const gone = await location('Old flat');
    await own(
      `UPDATE public.locations SET deleted_at = now() - interval '31 days',
                                   purge_after = now() - interval '1 day' WHERE id = $1`,
      [gone.id],
    );

    const report = await runPurge({ pools: db.pools, log, blobs: null });

    expect(report).toMatchObject({ trashed: 1, locations: 0, blobs: 0, skippedFiles: true });
    expect(await exists('things', old)).toBe(false);
    // The file row stays (unattached now), so a worker with storage deletes it and its blob.
    expect(await own('SELECT 1 FROM public.files WHERE storage_key = $1', [blob])).toHaveLength(1);
    expect(await blobs.exists(blob)).toBe(true);
    expect(await exists('locations', gone.id)).toBe(true);
    expect(logs.some((l) => l.msg.includes('no file storage'))).toBe(true);

    await runPurge({ pools: db.pools, log, blobs });
    expect(await blobs.exists(blob)).toBe(false);
  });

  it('fails the job, naming the key, when a blob will not delete; the rest is still done', async () => {
    const home = await location('Home');
    const first = await file(home, 2);
    const second = await file(home, 2);
    const stuck = [first, second].sort()[0] as string;
    const flaky: BlobStore = {
      ...blobs,
      put: blobs.put.bind(blobs),
      stream: blobs.stream.bind(blobs),
      exists: blobs.exists.bind(blobs),
      signedUrl: blobs.signedUrl.bind(blobs),
      delete: async (key) => {
        if (key === stuck) throw new Error('disk is read-only');
        await blobs.delete(key);
      },
    };
    const [job] = trashJobs({
      pools: db.pools,
      log,
      mailer: { send: async () => {} },
      publicUrl: 'http://kept.test',
      files: {
        blobs: flaky,
        signer: createUrlSigner(randomBytes(32)),
        maxFileBytes: 1,
        imageConcurrency: 1,
        tmpDir: dir,
      },
    });
    await expect((job as SystemJob).handler({})).rejects.toThrow(stuck);
    const other = stuck === first ? second : first;
    expect(await blobs.exists(other)).toBe(false);
    expect(logs.some((l) => l.level === 'error' && (l.obj as { key?: string }).key === stuck)).toBe(
      true,
    );
  });
});
