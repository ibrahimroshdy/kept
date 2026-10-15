import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EXPORT_PATHS, newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { stageKeptRun } from '../../test/kept-export.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, ok, own, place, setDisplayName } from '../../test/things.js';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import { withScope } from '../db/scope.js';
import { entitySchema } from '../exports/format.js';
import { buildExport } from '../exports/job.js';
import { importedId } from '../imports/kept/ids.js';
import { runKeptImport } from '../imports/kept/job.js';
import { openKeptArchive, readManifest } from '../imports/kept/read.js';
import { exportKey, importArchiveKey } from '../storage/blob-store.js';

// Condition reports in a Kept export (D238, builds D235). Louis records Flat's move-in, with
// photos, and Ibrahim finishes it; a move-out is still a draft. Ibrahim exports Flat (the real
// export job) and Nora imports it on another server (a fresh database and blob store, the real
// import job). Both reports come back as they were: kind, day, notes, rooms, conditions, notes,
// the photos byte for byte with the times Kept received them, and the finished one finished at
// the same time and still locked. Who added a photo and who finished the report is Nora, as every
// imported row's maker is the importing person (Q11); the history keeps the old names.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const keys = fixedSecretKeys(keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }));
const log = { info: () => {}, error: () => {} };

let db: TestDb;
let db2: TestDb;
let files: TestFiles;
let files2: TestFiles;
let t: TestApp;
let t2: TestApp;
let ibrahim: Person;
let louis: Person;
let nora: Person;
let flat: Loc;
let target: Loc;
let kitchen: string;
let archive: { file: string; bytes: number; sha256: string; dir: string };
let runId: string;
let runAt: number;

type Photo = {
  id: string;
  addedAt: string;
  sort: number;
  file: { id: string } | null;
  createdBy: { displayName: string };
};
type Room = {
  id: string;
  placeId: string | null;
  name: string;
  condition: string | null;
  note: string | null;
  sort: number;
  photos: Photo[];
  rowVersion: number;
};
type Report = {
  id: string;
  kind: string;
  heldOn: string;
  notes: string | null;
  finishedAt: string | null;
  finishedBy: { displayName: string } | null;
  rooms: Room[];
  rowVersion: number;
};

let moveIn: Report;
let moveOut: Report;

const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });
const read = async (app: TestApp, as: Person, id: string) =>
  ok(await call(app, `/api/v1/condition-reports/${id}`, { as })) as unknown as Report;

const acknowledgeKit = (d: TestDb) =>
  own(
    d,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );

async function photo(app: TestApp, as: Person, loc: Loc, roomId: string) {
  const up = ok(await upload(app, as, loc.id, await uniqueJpeg()), 201);
  return call(app, '/api/v1/attachments', {
    as,
    body: {
      id: newId(),
      locationId: loc.id,
      fileId: up.id,
      subject: { conditionRoomId: roomId },
      role: 'photo',
    },
  });
}

async function patchRoom(as: Person, room: Room, body: object) {
  ok(
    await call(t, `/api/v1/condition-rooms/${room.id}`, {
      method: 'PATCH',
      as,
      headers: ifMatch(room.rowVersion),
      body,
    }),
  );
}

/** Every entry name of a ZIP on disk. */
function entryNames(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, z) => {
      if (err || !z) return reject(err);
      const names: string[] = [];
      z.on('entry', (e: yauzl.Entry) => {
        names.push(e.fileName);
        z.readEntry();
      });
      z.on('end', () => {
        z.close();
        resolve(names);
      });
      z.on('error', reject);
      z.readEntry();
    });
  });
}

/** The SHA-256 of each photo's original, by attachment id. */
const shaOf = (d: TestDb, attachmentIds: string[]) =>
  own<{ id: string; sha256: string }>(
    d,
    `SELECT a.id, f.sha256 FROM public.attachments a JOIN public.files f ON f.id = a.file_id
      WHERE a.id = ANY ($1::uuid[])`,
    [attachmentIds],
  ).then((rows) => new Map(rows.map((r) => [r.id, r.sha256.trim()])));

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  await acknowledgeKit(db);
  // An export is https only (D181).
  t = await peopleApp(db, {
    sent: [],
    files,
    secretKeys: keys,
    publicUrl: 'https://kept.example',
  });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  flat = await createLocation(t, db, ibrahim, 'household', 'Flat');
  await join(db, flat.id, louis.userId, 'member');
  kitchen = await place(db, flat, 'Kitchen');
  await place(db, flat, 'Bedroom');

  // The move-in: two rooms recorded, a room added by name, photos, then finished by Ibrahim.
  const started = ok(
    await call(t, `/api/v1/locations/${flat.id}/condition-reports`, {
      as: louis,
      body: { kind: 'move_in', heldOn: '2026-09-01', notes: 'Keys: 2. Meter 4512.' },
    }),
    201,
  ) as unknown as Report;
  ok(
    await call(t, `/api/v1/condition-reports/${started.id}/rooms`, {
      as: louis,
      body: { name: 'Balcony' },
    }),
    201,
  );
  let report = await read(t, louis, started.id);
  const room = (name: string) => report.rooms.find((r) => r.name === name) as Room;
  await patchRoom(louis, room('Kitchen'), {
    condition: 'fair',
    note: 'Chip in the worktop by the sink',
  });
  await patchRoom(louis, room('Balcony'), { condition: 'damaged', note: 'Cracked tile' });
  ok(await photo(t, louis, flat, room('Kitchen').id), 201);
  ok(await photo(t, louis, flat, room('Kitchen').id), 201);
  ok(await photo(t, ibrahim, flat, room('Balcony').id), 201);
  report = await read(t, louis, started.id);
  ok(
    await call(t, `/api/v1/condition-reports/${started.id}/finish`, {
      method: 'POST',
      as: ibrahim,
      headers: ifMatch(report.rowVersion),
    }),
  );
  moveIn = await read(t, louis, started.id);
  expect(moveIn.finishedBy).toEqual({ displayName: 'Ibrahim' });

  // The move-out: a draft with one photo.
  const out = ok(
    await call(t, `/api/v1/locations/${flat.id}/condition-reports`, {
      as: louis,
      body: { kind: 'move_out', heldOn: '2026-10-10' },
    }),
    201,
  ) as unknown as Report;
  const outKitchen = out.rooms.find((r) => r.placeId === kitchen) as Room;
  await patchRoom(louis, outKitchen, { condition: 'poor' });
  ok(await photo(t, louis, flat, outKitchen.id), 201);
  moveOut = await read(t, louis, out.id);

  // Ibrahim exports Flat, through the route and the real job.
  const res = await call(t, '/api/v1/exports', {
    as: ibrahim,
    body: { scope: { locationId: flat.id }, options: { readable: true, pdf: false } },
  });
  expect(res.statusCode, res.body).toBe(202);
  const { id: exportId } = res.json() as { id: string };
  const outcome = await buildExport(
    { pools: db.pools, files, secretKeys: keys, publicUrl: 'https://kept.example', log },
    { userId: ibrahim.userId, mfa: false },
    { exportId },
  );
  expect(outcome.status).toBe('done');
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-condition-'));
  const file = path.join(dir, 'flat.zip');
  const hash = createHash('sha256');
  const stream = await files.blobs.stream(exportKey(exportId));
  stream.on('data', (c: Buffer) => hash.update(c));
  await pipeline(stream, createWriteStream(file));
  archive = { file, bytes: (await stat(file)).size, sha256: hash.digest('hex'), dir };

  // Nora, on another server.
  db2 = await testDb('b');
  await db2.reset();
  files2 = await testFiles();
  await acknowledgeKit(db2);
  t2 = await peopleApp(db2, { files: files2, secretKeys: keys });
  nora = await person(t2, db2, 'nora');
  await setDisplayName(db2, nora, 'Nora');
  target = await createLocation(t2, db2, nora, 'household', 'Flat');
  runId = await stageKeptRun(
    db2,
    files2,
    { ...archive, manifest: { keptVersion: 'test' } as never },
    { userId: nora.userId, locationId: target.id },
  );
  await runKeptImport(
    { pools: db2.pools, files: files2, keys, log },
    { userId: nora.userId, mfa: true },
    runId,
  );
  const [run] = await own<{ status: string; error: string | null; created_at: Date }>(
    db2,
    'SELECT status, error, created_at FROM public.import_runs WHERE id = $1',
    [runId],
  );
  expect(run).toMatchObject({ status: 'done', error: null });
  runAt = run?.created_at.getTime() ?? 0;
});

afterAll(async () => {
  await t?.app.close();
  await t2?.app.close();
  await files?.cleanup();
  await files2?.cleanup();
  if (archive) await rm(archive.dir, { recursive: true, force: true });
});

const newIdOf = (oldId: string) => importedId(runId, oldId, runAt);

describe('a Kept export with condition reports (D238)', () => {
  it('holds the reports, their rooms, and their photos’ originals (format version 2)', async () => {
    const staged = await stageKeptRun(
      db,
      files,
      { ...archive, manifest: { keptVersion: 'x' } as never },
      { userId: ibrahim.userId, locationId: flat.id, status: 'draft' },
    );
    const opened = await openKeptArchive(files.blobs, staged, archive.bytes);
    try {
      const manifest = await readManifest(opened);
      expect(manifest.version).toBe(2);
      expect(manifest.counts['condition-reports']).toBe(2);
      expect(manifest.counts['condition-report-rooms']).toBe(
        moveIn.rooms.length + moveOut.rooms.length,
      );
      const reports: Record<string, unknown>[] = [];
      for await (const r of opened.ndjson(
        EXPORT_PATHS.data('condition-reports'),
        entitySchema('condition-reports'),
      )) {
        reports.push(r as Record<string, unknown>);
      }
      expect(reports.find((r) => r.id === moveIn.id)).toMatchObject({
        kind: 'move_in',
        heldOn: '2026-09-01',
        notes: 'Keys: 2. Meter 4512.',
        finishedAt: moveIn.finishedAt,
      });
      // No user of this server leaves in it.
      expect(JSON.stringify(reports)).not.toContain(ibrahim.userId);
      expect(JSON.stringify(reports)).not.toContain(louis.userId);
      // Every photo's original is in the archive.
      const photos = [...moveIn.rooms, ...moveOut.rooms].flatMap((r) => r.photos);
      expect(photos).toHaveLength(4);
      const inArchive = new Set(manifest.files.map((f) => f.id));
      for (const p of photos) expect(inArchive.has(p.file?.id ?? '')).toBe(true);
    } finally {
      opened.close();
    }
    // The readable copy has them as spreadsheets too.
    const names = await entryNames(archive.file);
    expect(names).toContain('readable/condition-reports.csv');
    expect(names).toContain('readable/condition-report-rooms.csv');
  });

  it('imports both reports as they were: kind, day, notes, rooms and photos', async () => {
    for (const source of [moveIn, moveOut]) {
      const got = await read(t2, nora, newIdOf(source.id));
      expect(got).toMatchObject({
        kind: source.kind,
        heldOn: source.heldOn,
        notes: source.notes,
      });
      const shape = (rooms: Room[], placeOf: (id: string | null) => string | null) =>
        rooms.map((r) => ({
          name: r.name,
          condition: r.condition,
          note: r.note,
          sort: r.sort,
          placeId: placeOf(r.placeId),
          photos: r.photos.map((p) => ({ addedAt: p.addedAt, sort: p.sort })),
        }));
      expect(shape(got.rooms, (id) => id)).toEqual(
        shape(source.rooms, (id) => (id ? newIdOf(id) : null)),
      );
      // The photos, byte for byte; added by the importing person.
      const before = await shaOf(
        db,
        source.rooms.flatMap((r) => r.photos.map((p) => p.id)),
      );
      const after = await shaOf(
        db2,
        got.rooms.flatMap((r) => r.photos.map((p) => p.id)),
      );
      expect([...after.values()].sort()).toEqual([...before.values()].sort());
      for (const p of got.rooms.flatMap((r) => r.photos)) {
        expect(p.createdBy).toEqual({ displayName: 'Nora' });
      }
    }
    // A room's place is the imported place.
    const [kitchenHere] = await own<{ name: string }>(
      db2,
      'SELECT name FROM public.places WHERE id = $1 AND location_id = $2',
      [newIdOf(kitchen), target.id],
    );
    expect(kitchenHere?.name).toBe('Kitchen');
  });

  it('brings the finished report back finished at the same time, and the draft open', async () => {
    const finished = await read(t2, nora, newIdOf(moveIn.id));
    expect(finished.finishedAt).toBe(moveIn.finishedAt);
    expect(finished.finishedBy).toEqual({ displayName: 'Nora' });
    const draft = await read(t2, nora, newIdOf(moveOut.id));
    expect(draft.finishedAt).toBeNull();
    expect(draft.finishedBy).toBeNull();
    // The run says how many it finished; the history keeps who finished it there.
    const events = await own<{ action: string; actor_type: string; diff: unknown }>(
      db2,
      `SELECT action, actor_type, diff FROM public.audit_events
        WHERE location_id = $1 ORDER BY at, id`,
      [target.id],
    );
    const runEvent = events.find((e) => {
      const d = e.diff as Record<string, { after?: unknown }> | null;
      return d?.entity?.after === 'condition-reports' && d.finished !== undefined;
    });
    expect(runEvent).toMatchObject({ action: 'import.run', diff: { finished: { after: 1 } } });
    const finish = events.find(
      (e) => e.actor_type === 'import' && e.action === 'condition_report.finish',
    );
    expect(finish?.diff).toMatchObject({ _importedActor: 'Ibrahim' });
  });

  it('keeps the imported finished report locked, its rooms and photos too', async () => {
    const report = await read(t2, nora, newIdOf(moveIn.id));
    const patch = await call(t2, `/api/v1/condition-reports/${report.id}`, {
      method: 'PATCH',
      as: nora,
      headers: ifMatch(report.rowVersion),
      body: { notes: 'after the fact' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toMatchObject({ reason: 'report_finished' });
    const room = report.rooms.find((r) => r.name === 'Kitchen') as Room;
    const roomPatch = await call(t2, `/api/v1/condition-rooms/${room.id}`, {
      method: 'PATCH',
      as: nora,
      headers: ifMatch(room.rowVersion),
      body: { condition: 'good' },
    });
    expect(roomPatch.statusCode).toBe(409);
    const added = await call(t2, `/api/v1/condition-reports/${report.id}/rooms`, {
      as: nora,
      body: { name: 'Hall' },
    });
    expect(added.statusCode).toBe(409);
    expect((await photo(t2, nora, target, room.id)).statusCode).toBe(409);
    const remove = await call(t2, `/api/v1/attachments/${room.photos[0]?.id}`, {
      method: 'DELETE',
      as: nora,
    });
    expect(remove.statusCode).toBe(409);
    // And in the database, as kept_app: nothing changes, the photo trigger refuses.
    const scope = { userId: nora.userId, mfa: true };
    const changed = await withScope(db2.pools.app, scope, async (_tx, c) => {
      const a = await c.query(
        'UPDATE public.condition_reports SET finished_at = NULL, finished_by = NULL WHERE id = $1',
        [report.id],
      );
      const b = await c.query(
        "UPDATE public.condition_report_rooms SET note = 'x' WHERE report_id = $1",
        [report.id],
      );
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    });
    expect(changed).toBe(0);
    await expect(
      withScope(db2.pools.app, scope, (_tx, c) =>
        c.query('DELETE FROM public.attachments WHERE id = $1', [room.photos[0]?.id]),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'condition_report_finished' });
    // The imported draft is still a draft anyone who can write may change.
    const draft = await read(t2, nora, newIdOf(moveOut.id));
    ok(
      await call(t2, `/api/v1/condition-reports/${draft.id}`, {
        method: 'PATCH',
        as: nora,
        headers: ifMatch(draft.rowVersion),
        body: { notes: 'Landlord walked it with me' },
      }),
    );
  });

  it('finishes nothing twice when the job runs again', async () => {
    const before = await read(t2, nora, newIdOf(moveIn.id));
    await own(db2, `UPDATE public.import_runs SET status = 'running' WHERE id = $1`, [runId]);
    await files2.blobs.put(importArchiveKey(runId), archive.file, {
      contentType: 'application/zip',
      bytes: archive.bytes,
    });
    await runKeptImport(
      { pools: db2.pools, files: files2, keys, log },
      { userId: nora.userId, mfa: true },
      runId,
    );
    const after = await read(t2, nora, newIdOf(moveIn.id));
    // Photo links are signed per read; the rest is the same, row versions included.
    const settled = (r: Report) => ({
      ...r,
      rooms: r.rooms.map((x) => ({ ...x, photos: x.photos.map((p) => p.id) })),
    });
    expect(settled(after)).toEqual(settled(before));
  });
});
