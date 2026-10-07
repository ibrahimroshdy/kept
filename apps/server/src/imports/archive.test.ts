import { newId, ZIP_LIMITS } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import {
  declareArchive,
  homeboxZip,
  putArchive,
  uploadArchive,
} from '../../test/archive-imports.js';
import { type TestDb, testDb } from '../../test/db.js';
import { sha256, type TestFiles, testFiles } from '../../test/files.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, type Loc, ok, own } from '../../test/things.js';
import { forgeZip } from '../../test/zip-forge.js';
import { importArchiveKey } from '../storage/blob-store.js';
import { pruneImports } from './prune.js';

// Step-7 T8 (D146, D157, Q8, Q18): an archive import's upload, inspection, target and choices,
// and the prune of abandoned runs, through the front door. Ibrahim owns Home; Bruce is its
// admin, Louis a member. Alfred shares nothing with them.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let alfred: Person;
let home: Loc;
let homeZip: Buffer;

const log = { info: () => {}, error: () => {} };

type RunView = {
  id: string;
  locationId: string | null;
  source: string;
  status: string;
  bytes: number;
  sha256: string;
  archiveReadyAt: string | null;
  inspect: Record<string, unknown> | null;
  choices: unknown;
  error: string | null;
  reason?: string;
  rowVersion: number;
};

const runOf = async (as: Person, id: string) =>
  ok(await call(t, `/api/v1/imports/${id}`, { as })) as unknown as RunView;
const inspect = (as: Person, id: string) =>
  call(t, `/api/v1/imports/${id}/inspect`, { as, body: {} });
const target = (as: Person, id: string, body: object) =>
  call(t, `/api/v1/imports/${id}/target`, { as, body });
const newLocation = (name = 'Imported') => ({
  newLocation: { name, kind: 'home', timezone: 'Africa/Cairo', currency: 'EGP' },
});

/** The run's audit events, oldest first (as kept_owner), wherever they belong. */
const runEvents = (id: string) =>
  own<{
    action: string;
    location_id: string | null;
    owner_account_id: string | null;
    diff: unknown;
  }>(
    db,
    `SELECT action, location_id, owner_account_id, diff FROM public.audit_events
      WHERE entity_type = 'import_run' AND entity_id = $1 ORDER BY at, id`,
    [id],
  );

const choices = {
  archived: 'skip',
  currency: 'EGP',
  quantityRounding: 'keep_note',
  fields: {},
  types: {},
  insured: 'field',
  seeded: 'skip_unused',
};

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  homeZip = await homeboxZip('home');
}, 120_000);

afterAll(async () => {
  await files?.cleanup();
});

describe('POST /api/v1/imports/archive', () => {
  // catalogue: POST /api/v1/imports/archive
  it('declares a draft with no location, audited in the account with its size and hash only', async () => {
    const id = newId();
    const run = ok(await declareArchive(t, ibrahim, homeZip, { id }), 201) as unknown as RunView;
    expect(run).toMatchObject({
      id,
      locationId: null,
      source: 'homebox_zip',
      status: 'draft',
      bytes: homeZip.length,
      sha256: sha256(homeZip),
      archiveReadyAt: null,
      inspect: null,
    });
    const events = await runEvents(id);
    expect(events.map((e) => e.action)).toEqual(['import.create']);
    expect(events[0]?.location_id).toBeNull();
    expect(events[0]?.owner_account_id).not.toBeNull();
    // The same declaration again answers the run; the id with other bytes doesn't.
    ok(await declareArchive(t, ibrahim, homeZip, { id }), 201);
    const other = await declareArchive(t, ibrahim, homeZip, { id, sha: 'a'.repeat(64) });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'idempotency_mismatch' });
  });

  it('refuses an archive over 5 GB with 413 before anything is stored', async () => {
    const id = newId();
    const res = await declareArchive(t, ibrahim, homeZip, {
      id,
      size: ZIP_LIMITS.archiveBytes + 1,
    });
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json()).toMatchObject({ code: 'archive_too_large', reason: 'too_large' });
    expect(await own(db, 'SELECT 1 FROM public.import_runs WHERE id = $1', [id])).toHaveLength(0);
  });

  it('is its creator’s alone until it has a target', async () => {
    const id = await uploadArchive(t, ibrahim, homeZip);
    for (const p of [bruce, louis, alfred]) {
      expect((await call(t, `/api/v1/imports/${id}`, { as: p })).statusCode).toBe(404);
      expect((await inspect(p, id)).statusCode).toBe(404);
    }
    const listed = ok(await call(t, '/api/v1/imports', { as: ibrahim })) as unknown as {
      items: { id: string }[];
    };
    expect(listed.items.map((r) => r.id)).toContain(id);
    const theirs = ok(await call(t, '/api/v1/imports', { as: alfred })) as unknown as {
      items: { id: string }[];
    };
    expect(theirs.items.map((r) => r.id)).not.toContain(id);
  });
});

describe('PUT /api/v1/imports/:id/archive', () => {
  // catalogue: PUT /api/v1/imports/:id/archive
  it('stores the bytes under i/<id>.zip, audited with size and hash, and a replay answers 200', async () => {
    const id = newId();
    ok(await declareArchive(t, ibrahim, homeZip, { id }), 201);
    const run = ok(await putArchive(t, ibrahim, id, homeZip)) as unknown as RunView;
    expect(run.archiveReadyAt).not.toBeNull();
    expect(await files.blobs.exists(importArchiveKey(id))).toBe(true);
    const events = await runEvents(id);
    expect(events.map((e) => e.action)).toEqual(['import.create', 'import.archive']);
    expect(events[1]?.diff).toMatchObject({ sha256: { after: sha256(homeZip) } });
    const again = ok(await putArchive(t, ibrahim, id, homeZip)) as unknown as RunView;
    expect(again.archiveReadyAt).toBe(run.archiveReadyAt);
  });

  it('refuses other bytes than declared (409), a short body (400) and a wrong hash (400), storing nothing', async () => {
    const other = forgeZip([{ name: 'manifest.json', data: Buffer.from('{}') }]);
    const id = newId();
    ok(await declareArchive(t, ibrahim, homeZip, { id }), 201);
    const swapped = await putArchive(t, ibrahim, id, other);
    expect(swapped.statusCode, swapped.body).toBe(409);
    expect(swapped.json()).toMatchObject({ code: 'idempotency_mismatch' });

    // Declared longer than what is sent.
    const shortId = newId();
    ok(await declareArchive(t, ibrahim, homeZip, { id: shortId, size: homeZip.length + 10 }), 201);
    const short = await putArchive(t, ibrahim, shortId, homeZip);
    expect(short.statusCode, short.body).toBe(400);

    // The header names the declared hash, but other bytes of the same length arrive.
    const lying = Buffer.from(homeZip);
    lying[lying.length - 1] = (lying[lying.length - 1] ?? 0) ^ 0xff;
    const lieId = newId();
    ok(await declareArchive(t, ibrahim, homeZip, { id: lieId }), 201);
    const lie = await putArchive(t, ibrahim, lieId, lying, { sha: sha256(homeZip) });
    expect(lie.statusCode, lie.body).toBe(400);
    expect(lie.json()).toMatchObject({ code: 'checksum_mismatch' });

    for (const run of [id, shortId, lieId]) {
      expect(await files.blobs.exists(importArchiveKey(run))).toBe(false);
      expect((await runOf(ibrahim, run)).archiveReadyAt).toBeNull();
    }
  });

  it('is a 404 for someone else’s draft', async () => {
    const id = newId();
    ok(await declareArchive(t, ibrahim, homeZip, { id }), 201);
    expect((await putArchive(t, alfred, id, homeZip)).statusCode).toBe(404);
  });
});

describe('POST /api/v1/imports/:id/inspect', () => {
  // catalogue: POST /api/v1/imports/:id/inspect
  it('reads a Homebox export’s manifest, counts and mapping hints, and stores them', async () => {
    const id = await uploadArchive(t, ibrahim, homeZip);
    const res = ok(await inspect(ibrahim, id)) as unknown as {
      source: string;
      sourceVersion: string | null;
      collections: {
        id: string;
        name?: string;
        exportedAt: string;
        counts: Record<string, number>;
        mapping: {
          types: { name: string; items: number }[];
          fields: { name: string; kind: string; items: number }[];
          insuredItems: number;
          seededUnused: { places: string[]; tags: string[] };
        };
      }[];
    };
    expect(res.source).toBe('homebox_zip');
    expect(res.sourceVersion).toBeNull();
    const [c] = res.collections;
    expect(c?.id).toBe('1d93892c-082a-4fb4-9645-b78321688b99');
    expect(c?.name).toBeUndefined();
    expect(c?.exportedAt).toBe('2026-09-29T22:43:10.788Z');
    expect(c?.counts).toEqual({
      entities: 21,
      locations: 13,
      attachments: 9,
      maintenance: 2,
      tags: 10,
      types: 7,
    });
    expect(c?.mapping.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Appliance', items: 3 }),
        expect.objectContaining({ name: 'Tool', items: 3 }),
        expect.objectContaining({ name: 'Gadget', items: 1 }),
        expect.objectContaining({ name: 'Odd icon', items: 1 }),
      ]),
    );
    expect(c?.mapping.types).toHaveLength(4);
    expect(c?.mapping.fields).toEqual(
      expect.arrayContaining([
        { name: 'Colour', kind: 'text', items: 1 },
        { name: 'Boiler size (ml)', kind: 'number', items: 1 },
        { name: 'Plumbed in', kind: 'boolean', items: 1 },
        { name: 'Installed', kind: 'time', items: 1 },
      ]),
    );
    expect(c?.mapping.insuredItems).toBe(1);
    expect([...(c?.mapping.seededUnused.places ?? [])].sort()).toEqual([
      'Attic',
      'Basement',
      'Bathroom',
      'Bedroom',
      'Garage',
      'Kitchen',
      'Living Room',
      'Office',
    ]);
    expect([...(c?.mapping.seededUnused.tags ?? [])].sort()).toEqual([
      'Appliances',
      'Electronics',
      'General',
      'IOT',
      'Important',
      'Servers',
    ]);
    expect((await runOf(ibrahim, id)).inspect).toEqual(res);
    const events = await runEvents(id);
    expect(events.at(-1)?.action).toBe('import.inspect');
    // A second inspect answers what is stored.
    expect(ok(await inspect(ibrahim, id))).toEqual(res);
  });

  it('refuses a hostile archive with its reason, and fails the run', async () => {
    const hostile = forgeZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'attachments/link', data: Buffer.from('/etc/passwd'), madeBy: 3, unixMode: 0o120777 },
    ]);
    const id = await uploadArchive(t, ibrahim, hostile);
    const res = await inspect(ibrahim, id);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'archive_invalid', reason: 'symlink' });
    const run = await runOf(ibrahim, id);
    expect(run).toMatchObject({ status: 'failed', error: 'archive_invalid', reason: 'symlink' });
    expect((await runEvents(id)).at(-1)?.action).toBe('import.inspect');
    // Asked again, it answers the same refusal without reading the archive.
    expect((await inspect(ibrahim, id)).json()).toMatchObject({ reason: 'symlink' });
  });

  it('refuses a ZIP that is no Homebox export (no manifest), with no reason', async () => {
    const id = await uploadArchive(
      t,
      ibrahim,
      forgeZip([{ name: 'hello.txt', data: Buffer.from('hi') }]),
    );
    const res = await inspect(ibrahim, id);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'archive_invalid' });
    expect(res.json()).not.toHaveProperty('reason');
  });
});

describe('POST /api/v1/imports/:id/target', () => {
  // catalogue: POST /api/v1/imports/:id/target
  it('creates a new location in the caller’s account, with its Unplaced area, once', async () => {
    const id = await uploadArchive(t, ibrahim, homeZip);
    const run = ok(await target(ibrahim, id, newLocation('From Homebox'))) as unknown as RunView;
    expect(run.locationId).not.toBeNull();
    const [loc] = await own<{ owner: string; unplaced: number; role: string }>(
      db,
      `SELECT l.owner_account_id::text AS owner,
              (SELECT count(*)::int FROM public.places p WHERE p.location_id = l.id AND p.is_unplaced)
                AS unplaced,
              (SELECT m.role FROM public.memberships m WHERE m.location_id = l.id AND m.user_id = $2)
                AS role
         FROM public.locations l WHERE l.id = $1`,
      [run.locationId, ibrahim.userId],
    );
    expect(loc).toEqual({ owner: home.accountId, unplaced: 1, role: 'owner' });
    const events = await runEvents(id);
    expect(events.at(-1)).toMatchObject({ action: 'import.target', location_id: run.locationId });
    // Set once.
    const again = await target(ibrahim, id, { locationId: home.id });
    expect(again.statusCode).toBe(409);
  });

  it('takes an existing location from an admin (Bruce) but not a member (Louis: 403)', async () => {
    const louisRun = await uploadArchive(t, louis, homeZip);
    expect((await target(louis, louisRun, { locationId: home.id })).statusCode).toBe(403);
    const bruceRun = await uploadArchive(t, bruce, homeZip);
    const run = ok(await target(bruce, bruceRun, { locationId: home.id })) as unknown as RunView;
    expect(run.locationId).toBe(home.id);
    // Targeted, the location's owner sees it too; the member doesn't.
    expect((await runOf(ibrahim, bruceRun)).id).toBe(bruceRun);
    expect((await call(t, `/api/v1/imports/${bruceRun}`, { as: louis })).statusCode).toBe(404);
    // Alfred can't target a location he can't see.
    const alfredRun = await uploadArchive(t, alfred, homeZip);
    expect((await target(alfred, alfredRun, { locationId: home.id })).statusCode).toBe(404);
  });

  it('takes only a new location for a Kept export (400 for an existing one)', async () => {
    const id = newId();
    ok(await declareArchive(t, ibrahim, homeZip, { id, source: 'kept_zip' }), 201);
    const res = await target(ibrahim, id, { locationId: home.id });
    expect(res.statusCode, res.body).toBe(400);
  });
});

describe('POST /api/v1/imports/:id/choices', () => {
  // catalogue: POST /api/v1/imports/:id/choices
  it('stores the Homebox choices under If-Match, audited, and needs the target first', async () => {
    const id = await uploadArchive(t, ibrahim, homeZip);
    let run = await runOf(ibrahim, id);
    const early = await call(t, `/api/v1/imports/${id}/choices`, {
      as: ibrahim,
      body: { choices },
      headers: { 'if-match': String(run.rowVersion) },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'import_target_needed' });

    run = ok(await target(ibrahim, id, { locationId: home.id })) as unknown as RunView;
    const stale = await call(t, `/api/v1/imports/${id}/choices`, {
      as: ibrahim,
      body: { choices },
      headers: { 'if-match': String(run.rowVersion - 1) },
    });
    expect(stale.statusCode).toBe(412);
    const saved = ok(
      await call(t, `/api/v1/imports/${id}/choices`, {
        as: ibrahim,
        body: { choices },
        headers: { 'if-match': String(run.rowVersion) },
      }),
    ) as unknown as RunView;
    expect(saved.choices).toEqual(choices);
    const events = await runEvents(id);
    expect(events.at(-1)).toMatchObject({ action: 'import.choices', location_id: home.id });
  });
});

describe('cancelling an archive run', () => {
  it('deletes its archive and keeps the run as cancelled', async () => {
    const id = await uploadArchive(t, ibrahim, homeZip);
    const res = ok(await call(t, `/api/v1/imports/${id}/cancel`, { as: ibrahim, body: {} }));
    expect(res).toMatchObject({ status: 'cancelled', archiveReadyAt: null });
    expect(await files.blobs.exists(importArchiveKey(id))).toBe(false);
  });
});

describe('prune-imports', () => {
  it('removes an abandoned draft’s archive and clears it, and leaves a running run alone', async () => {
    const abandoned = await uploadArchive(t, ibrahim, homeZip);
    const running = await uploadArchive(t, ibrahim, homeZip);
    ok(await target(ibrahim, running, { locationId: home.id }));
    await own(db, `UPDATE public.import_runs SET status = 'running' WHERE id = $1`, [running]);

    const result = await pruneImports({
      pools: db.pools,
      files,
      log,
      before: new Date(Date.now() + 60_000),
    });
    expect(result.runs).toBeGreaterThanOrEqual(1);
    expect(await files.blobs.exists(importArchiveKey(abandoned))).toBe(false);
    const [row] = await own<{ status: string; archive_bytes: string | null; inspect: unknown }>(
      db,
      'SELECT status, archive_bytes, inspect FROM public.import_runs WHERE id = $1',
      [abandoned],
    );
    expect(row).toEqual({ status: 'cancelled', archive_bytes: null, inspect: null });
    expect(await files.blobs.exists(importArchiveKey(running))).toBe(true);
    const [still] = await own<{ status: string }>(
      db,
      'SELECT status FROM public.import_runs WHERE id = $1',
      [running],
    );
    expect(still?.status).toBe('running');
  });
});
