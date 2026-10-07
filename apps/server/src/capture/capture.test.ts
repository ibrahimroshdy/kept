import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  fixture,
  sha256,
  type TestFiles,
  testFiles,
  uniqueJpeg,
  upload,
} from '../../test/files.js';
import {
  auditOf,
  call,
  freshIp,
  join,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
} from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';
import { AUDIT_EVENT_HEADER, REPLAYED_HEADER } from '../http/write.js';

// T13: the online capture path, the phone's display image and batch undo, through the front door
// in the web contract's shapes (apps/web/src/api/capture/types.ts "capture (T13)").

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let bruce: Person; // another household: his own Garage, nothing of Home's
let home: Loc;
let garage: Loc;
let shelf: string;

const blob = (key: string) => readFile(path.join(files.blobs.root, key));

/** An upload of the caller's own; answers the file id. */
async function up(as: Person, loc: Loc, bytes?: Buffer, cls = 'photo'): Promise<string> {
  const res = await upload(t, as, loc.id, bytes ?? (await uniqueJpeg()), { cls });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** POST /api/v1/captures with an Idempotency-Key (a fresh one unless given). */
function capture(as: Person, body: Record<string, unknown>, key: string | null = newId()) {
  return call(t, '/api/v1/captures', {
    as,
    body,
    headers: key ? { 'idempotency-key': key } : {},
  });
}

/** A capture body with the defaults the phone sends. */
function body(loc: Loc, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: newId(),
    locationId: loc.id,
    target: { unplaced: true },
    mode: 'thing',
    batchId: newId(),
    files: [],
    ...over,
  };
}

const photo = (fileId: string, role = 'photo') => ({ fileId, role });

function putDisplay(as: Person, fileId: string, jpeg: Buffer, sha: string = sha256(jpeg)) {
  return t.app.inject({
    method: 'PUT',
    url: `/api/v1/files/${fileId}/display`,
    headers: {
      origin: t.publicUrl,
      cookie: as.cookie,
      'content-type': 'image/jpeg',
      'x-kept-sha256': sha,
    },
    remoteAddress: freshIp(),
    payload: jpeg,
  });
}

const undoBatch = (as: Person, batchId: string) =>
  call(t, `/api/v1/captures/batches/${batchId}/undo`, { as, body: {} });

const undoEvent = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

const auditActions = async (locationId: string, action: string) =>
  (await auditOf(db, locationId)).filter((e) => e.action === action);

const thingRow = async (id: string) =>
  (
    await own<{
      name: string | null;
      review_state: string;
      field_status: Record<string, unknown>;
      capture_batch_id: string | null;
      deleted_at: Date | null;
      place_id: string | null;
    }>(
      db,
      `SELECT name, review_state, field_status, capture_batch_id, deleted_at, place_id
         FROM public.things WHERE id = $1`,
      [id],
    )
  )[0];

const inboxOf = (subject: string) =>
  own<{ id: string; kind: string; batch_id: string | null; extraction_id: string | null }>(
    db,
    `SELECT id, kind, batch_id, extraction_id FROM public.inbox_items
      WHERE (thing_id = $1 OR purchase_id = $1) AND resolved_at IS NULL`,
    [subject],
  );

/** AI capture on for a location: an account key with a vision model (kept.ai_cascade). */
async function aiOn(loc: Loc, owner: Person): Promise<void> {
  await own(
    db,
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                      key_version, models, created_by)
     VALUES ($1, 'account', $2, 'groq', '{"v": 1}', 1, $3, $4)`,
    [newId(), loc.accountId, JSON.stringify({ vision: 'qwen/qwen3.8-27b' }), owner.userId],
  );
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files, sent });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  bruce = await person(t, db, 'bruce');
  home = await createLocation(t, db, ibrahim, 'household');
  garage = await createLocation(t, db, bruce, 'household', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  shelf = await place(db, home, 'Shelf A');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('POST /api/v1/captures', () => {
  // catalogue: POST /api/v1/captures
  it('makes a photo-only capture a draft with an inbox draft item, and answers its undo event', async () => {
    const fileId = await up(louis, home);
    const b = body(home, { files: [photo(fileId)] });
    const res = await capture(louis, b);
    const out = ok(res, 201) as Json & {
      thing: { id: string; name: string | null; shortCode: string | null; derivedState: string[] };
      inboxItemId: string;
      undo: { eventId: string; until: string };
    };
    expect(out.thing).toMatchObject({ id: b.id, name: null, derivedState: ['draft'] });
    expect(out.thing.shortCode).toMatch(/^[0-9A-Z]{6}$/);
    // AI capture is on in Home (the household preset) but no provider resolves: the photo waits
    // for one, with no job until a key is connected.
    const waiting = out.extraction as unknown as { id: string; status: string };
    expect(waiting.status).toBe('waiting_provider');
    const row = await thingRow(b.id as string);
    expect(row).toMatchObject({
      name: null,
      review_state: 'draft',
      capture_batch_id: b.batchId,
      place_id: home.unplacedId,
    });
    expect(await inboxOf(b.id as string)).toEqual([
      { id: out.inboxItemId, kind: 'draft', batch_id: b.batchId, extraction_id: waiting.id },
    ]);
    expect(
      await own(db, 'SELECT status, status_reason FROM public.extractions WHERE id = $1', [
        waiting.id,
      ]),
    ).toEqual([{ status: 'waiting_provider', status_reason: 'no_provider' }]);
    expect(
      sent.some((j) => (j.data as { extractionId?: string }).extractionId === waiting.id),
    ).toBe(false);
    // The photo is the thing's.
    const atts = await own<{ file_id: string; role: string }>(
      db,
      'SELECT file_id, role FROM public.attachments WHERE thing_id = $1',
      [b.id],
    );
    expect(atts).toEqual([{ file_id: fileId, role: 'photo' }]);

    // One event, thing.capture (not thing.create), undoable, and named in the header (§7.7).
    const events = await auditOf(db, home.id);
    expect(events.filter((e) => e.action === 'thing.create')).toHaveLength(0);
    const captures = await own<{ id: string; actor_id: string; undoable_until: Date | null }>(
      db,
      `SELECT id, actor_id, undoable_until FROM public.audit_events
        WHERE action = 'thing.capture' AND entity_id = $1`,
      [b.id],
    );
    expect(captures).toHaveLength(1);
    expect(captures[0]?.actor_id).toBe(louis.userId);
    expect(captures[0]?.undoable_until).not.toBeNull();
    expect(out.undo.eventId).toBe(captures[0]?.id);
    expect(res.headers[AUDIT_EVENT_HEADER]).toBe(captures[0]?.id);
  });

  it('makes a name-only capture confirmed, typed by hand, and keeps it out of the inbox', async () => {
    const b = body(home, { name: 'Bosch drill', target: { placeId: shelf } });
    const out = ok(await capture(ibrahim, b), 201) as Json & { thing: Json };
    expect(out.thing).toMatchObject({ name: 'Bosch drill', derivedState: [] });
    expect(out.inboxItemId).toBeUndefined();
    expect(await thingRow(b.id as string)).toMatchObject({
      review_state: 'confirmed',
      field_status: { name: { state: 'manual' } },
      place_id: shelf,
    });
    expect(await inboxOf(b.id as string)).toEqual([]);
  });

  it('refuses a capture with neither a photo nor a name, and one without an Idempotency-Key', async () => {
    expect((await capture(ibrahim, body(home))).statusCode).toBe(400);
    const res = await capture(ibrahim, body(home, { name: 'Tape' }), null);
    expect(res.statusCode).toBe(400);
  });

  it('replays the same Idempotency-Key with the same answer, once', async () => {
    const key = newId();
    const b = body(home, { name: 'Ladder' });
    const first = await capture(ibrahim, b, key);
    const again = await capture(ibrahim, b, key);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(again.headers[REPLAYED_HEADER]).toBe('true');
    expect(again.headers[AUDIT_EVENT_HEADER]).toBe(first.headers[AUDIT_EVENT_HEADER]);
    const events = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.audit_events
        WHERE action = 'thing.capture' AND entity_id = $1`,
      [b.id],
    );
    expect(events[0]?.n).toBe(1);
    // The same key with another body is refused, not applied.
    const other = await capture(ibrahim, { ...b, name: 'Stepladder' }, key);
    expect(other.statusCode).toBe(409);
    expect((await thingRow(b.id as string))?.name).toBe('Ladder');
  });

  it('refuses a viewer with 403 and an outsider with 404', async () => {
    expect((await capture(talia, body(home, { name: 'Vase' }))).statusCode).toBe(403);
    expect((await capture(bruce, body(home, { name: 'Vase' }))).statusCode).toBe(404);
  });

  it("answers another household's container, and someone else's file, as 404", async () => {
    const box = (await createThing(t, bruce, garage, { name: 'Tool box' })).id;
    const res = await capture(
      ibrahim,
      body(home, { name: 'Pliers', target: { containerId: box } }),
    );
    expect(res.statusCode).toBe(404);
    const random = await capture(
      ibrahim,
      body(home, { name: 'Pliers', target: { containerId: newId() } }),
    );
    expect(res.json()).toEqual(random.json());
    // Louis's upload isn't Ibrahim's to capture with.
    const theirs = await up(louis, home);
    const taken = await capture(ibrahim, body(home, { files: [photo(theirs)] }));
    expect(taken.statusCode).toBe(404);
  });

  it('"+ photo to this thing" adds the photo to the thing and makes nothing new', async () => {
    const drill = (await createThing(t, ibrahim, home, { name: 'Drill' })).id;
    const first = await up(ibrahim, home);
    const second = await up(ibrahim, home);
    const b = body(home, { files: [photo(first)], attachToThingId: drill });
    const out = ok(await capture(ibrahim, b), 201) as Json & { thing: Json };
    ok(await capture(ibrahim, body(home, { files: [photo(second)], attachToThingId: drill })), 201);
    expect(out.thing.id).toBe(drill);
    expect(await thingRow(b.id as string)).toBeUndefined();
    const atts = await own<{ file_id: string; sort: number }>(
      db,
      'SELECT file_id, sort FROM public.attachments WHERE thing_id = $1 ORDER BY sort',
      [drill],
    );
    expect(atts).toEqual([
      { file_id: first, sort: 0 },
      { file_id: second, sort: 1 },
    ]);
  });

  it('files two receipt pages under one draft purchase, with one receipt inbox item', async () => {
    const page1 = await up(ibrahim, home, await uniqueJpeg(), 'evidence');
    const page2 = await up(ibrahim, home, await uniqueJpeg(), 'evidence');
    const b = body(home, { mode: 'receipt', files: [photo(page1, 'receipt')], note: 'Hardware' });
    const out = ok(await capture(ibrahim, b), 201) as Json & { purchaseId: string };
    expect(out.purchaseId).toBe(b.id);
    expect(out.thing).toBeUndefined();
    const next = ok(
      await capture(
        ibrahim,
        body(home, {
          mode: 'receipt',
          batchId: b.batchId,
          files: [photo(page2, 'receipt')],
          pageOf: b.id,
        }),
      ),
      201,
    );
    expect(next.purchaseId).toBe(b.id);
    const purchases = await own<{ purchased_on: string | null; review_state: string }>(
      db,
      'SELECT purchased_on, review_state FROM public.purchases WHERE id = $1',
      [b.id],
    );
    expect(purchases).toEqual([{ purchased_on: null, review_state: 'draft' }]);
    const pages = await own<{ file_id: string; role: string }>(
      db,
      'SELECT file_id, role FROM public.attachments WHERE purchase_id = $1 ORDER BY sort',
      [b.id],
    );
    expect(pages).toEqual([
      { file_id: page1, role: 'receipt' },
      { file_id: page2, role: 'receipt' },
    ]);
    expect((await inboxOf(b.id as string)).map((i) => i.kind)).toEqual(['receipt']);
    // A receipt's page with a thing's role is refused.
    const wrong = await capture(
      ibrahim,
      body(home, { mode: 'receipt', files: [photo(await up(ibrahim, home), 'photo')] }),
    );
    expect(wrong.statusCode).toBe(400);
  });

  it('logs a typed reading from a reading capture, and asks the inbox when there is none', async () => {
    const carType = await builtinType(db, 'car');
    const car = await createThing(t, ibrahim, home, { name: 'Corolla', typeId: carType });
    const meterId = ((car.meters as { id: string }[])[0] as { id: string }).id;
    const typed = body(home, {
      mode: 'reading',
      files: [photo(await up(ibrahim, home, await uniqueJpeg(), 'evidence'), 'proof')],
      attachToThingId: car.id,
      readingValue: '52340',
    });
    ok(await capture(ibrahim, typed), 201);
    const readings = await own<{ value: string; source: string }>(
      db,
      'SELECT value::text AS value, source FROM public.meter_readings WHERE meter_id = $1',
      [meterId],
    );
    expect(readings).toEqual([{ value: '52340.000', source: 'photo' }]);

    const asked = ok(
      await capture(
        ibrahim,
        body(home, {
          mode: 'reading',
          target: { containerId: car.id },
          files: [photo(await up(ibrahim, home, await uniqueJpeg(), 'evidence'), 'proof')],
        }),
      ),
      201,
    );
    expect(asked.inboxItemId).toBeDefined();
    expect((await inboxOf(car.id)).map((i) => i.kind)).toEqual(['reading']);
  });

  it('a photo that waited for a provider goes with its capturer’s next capture once there is one', async () => {
    const cabin = await createLocation(t, db, ibrahim, 'household', 'Cabin');
    const first = ok(
      await capture(ibrahim, body(cabin, { files: [photo(await up(ibrahim, cabin))] })),
      201,
    ) as Json & { extraction: { id: string; status: string } };
    expect(first.extraction.status).toBe('waiting_provider');
    await aiOn(cabin, ibrahim);
    sent.length = 0;
    const second = ok(
      await capture(ibrahim, body(cabin, { files: [photo(await up(ibrahim, cabin))] })),
      201,
    ) as Json & { extraction: { id: string; status: string } };
    expect(second.extraction.status).toBe('queued');
    expect(sent).toEqual([
      { name: 'extract', data: { extractionId: second.extraction.id } },
      { name: 'extract', data: { extractionId: first.extraction.id } },
    ]);
    expect(
      await own(db, 'SELECT status, status_reason FROM public.extractions WHERE id = $1', [
        first.extraction.id,
      ]),
    ).toEqual([{ status: 'queued', status_reason: null }]);
    // Ibrahim's account key goes again: the later tests start without one.
    await own(
      db,
      `UPDATE public.ai_providers SET disabled_at = now() WHERE owner_account_id = $1
         AND disabled_at IS NULL`,
      [cabin.accountId],
    );
  });

  it('with AI capture off in the location, a photo writes no extraction at all', async () => {
    const shed = await createLocation(t, db, ibrahim, 'household', 'Shed');
    await own(
      db,
      `INSERT INTO public.location_modules (location_id, module, enabled)
       VALUES ($1, 'ai_capture', false)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = false`,
      [shed.id],
    );
    const out = ok(
      await capture(ibrahim, body(shed, { files: [photo(await up(ibrahim, shed))] })),
      201,
    );
    expect(out.extraction).toBeUndefined();
  });

  it('queues an extraction and its job with AI capture on, and opens the draft with it', async () => {
    const studio = await createLocation(t, db, ibrahim, 'household', 'Studio');
    await aiOn(studio, ibrahim);
    const fileId = await up(ibrahim, studio);
    sent.length = 0;
    const b = body(studio, { files: [photo(fileId)] });
    const out = ok(await capture(ibrahim, b), 201) as Json & {
      extraction: { id: string; status: string };
    };
    expect(out.extraction.status).toBe('queued');
    const rows = await own<{ mode: string; thing_id: string; status: string }>(
      db,
      'SELECT mode, thing_id, status FROM public.extractions WHERE id = $1',
      [out.extraction.id],
    );
    expect(rows).toEqual([{ mode: 'thing', thing_id: b.id, status: 'queued' }]);
    expect(sent).toEqual([{ name: 'extract', data: { extractionId: out.extraction.id } }]);
    expect((await inboxOf(b.id as string))[0]?.extraction_id).toBe(out.extraction.id);
    // A name-only capture has no photo to read: no extraction.
    sent.length = 0;
    const named = ok(await capture(ibrahim, body(studio, { name: 'Easel' })), 201);
    expect(named.extraction).toBeUndefined();
    // Only its embedding is queued (step-6 T14), no extraction.
    expect(sent.map((j) => j.name)).toEqual(['embed-thing']);
  });
});

describe('PUT /api/v1/files/:fileId/display', () => {
  // catalogue: PUT /api/v1/files/:fileId/display
  it("makes a HEIC original viewable from the phone's JPEG, without metadata, keeping the original", async () => {
    const heic = await fixture('image.heic');
    const fileId = await up(ibrahim, home, heic, 'evidence');
    const before = await own<{ derivative_state: string; storage_key: string }>(
      db,
      'SELECT derivative_state, storage_key FROM public.files WHERE id = $1',
      [fileId],
    );
    expect(before[0]?.derivative_state).toBe('unavailable');
    const jpeg = await fixture('photo.jpg'); // carries EXIF and GPS
    const res = await putDisplay(ibrahim, fileId, jpeg);
    const view = ok(res, 200) as Json & { thumbUrl: string | null; displayUrl: string | null };
    expect(view).toMatchObject({ id: fileId, mime: 'image/heic', derivativeState: 'ready' });
    expect(view.thumbUrl).toMatch(/^\/f\//);
    expect(view.displayUrl).toMatch(/^\/f\//);

    const ds = await own<{ variant: string; storage_key: string }>(
      db,
      'SELECT variant, storage_key FROM public.file_derivatives WHERE file_id = $1 ORDER BY variant',
      [fileId],
    );
    expect(ds.map((d) => d.variant)).toEqual(['display', 'share', 'thumb']);
    for (const d of ds) {
      const meta = await sharp(await blob(d.storage_key)).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
    }
    // D117: the original is byte-identical.
    expect(sha256(await blob(before[0]?.storage_key as string))).toBe(sha256(heic));

    const events = await auditActions(home.id, 'file.display_set');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.diff)).toContain(sha256(jpeg));

    // The same bytes again: the same file, nothing written.
    const again = ok(await putDisplay(ibrahim, fileId, jpeg), 200);
    expect(again.derivativeState).toBe('ready');
    expect(await auditActions(home.id, 'file.display_set')).toHaveLength(1);
  });

  it('refuses a wrong hash, a non-JPEG and anyone but its uploader; a filed photo still takes one', async () => {
    const fileId = await up(ibrahim, home, await uniqueJpeg(), 'evidence');
    const jpeg = await uniqueJpeg();
    expect((await putDisplay(ibrahim, fileId, jpeg, sha256(Buffer.from('x')))).statusCode).toBe(
      400,
    );
    const png = await sharp({
      create: { width: 3, height: 3, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    expect((await putDisplay(ibrahim, fileId, png)).statusCode).toBe(415);
    // Louis can't see Ibrahim's unfiled upload: the same 404 as a random id.
    const theirs = await putDisplay(louis, fileId, jpeg);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toEqual((await putDisplay(louis, newId(), jpeg)).json());
    // Filed by the capture before its preview arrived: the uploader still sets it (0042's door).
    ok(await capture(ibrahim, body(home, { mode: 'label', files: [photo(fileId)] })), 201);
    expect(ok(await putDisplay(ibrahim, fileId, jpeg), 200).derivativeState).toBe('ready');
    // …and Louis, who sees it now, may not.
    expect((await putDisplay(louis, fileId, jpeg)).statusCode).toBe(403);
  });
});

describe('capture batches', () => {
  // catalogue: POST /api/v1/captures/batches/:batchId/undo
  it('undoes only your own unreviewed drafts, and undoing the undo brings them back', async () => {
    const batchId = newId();
    const draft = async (as: Person) => {
      const b = body(home, { batchId, files: [photo(await up(as, home))] });
      ok(await capture(as, b), 201);
      return b.id as string;
    };
    const mine1 = await draft(ibrahim);
    const mine2 = await draft(ibrahim);
    const reviewed = await draft(ibrahim);
    const named = body(home, { batchId, name: 'Hammer' });
    ok(await capture(ibrahim, named), 201);
    const louisDraft = await draft(louis);
    await own(
      db,
      `UPDATE public.things SET review_state = 'confirmed', name = 'Saw' WHERE id = $1`,
      [reviewed],
    );

    // The batch list shows it, grouped.
    const list = ok(
      await call(t, `/api/v1/captures/batches?locationId=${home.id}`, { as: ibrahim }),
    );
    const listed = (list.items as Json[]).find((b) => b.batchId === batchId);
    expect(listed).toMatchObject({ count: 5, drafts: 3, byMe: true, locationId: home.id });
    expect((listed?.placePath as Json[] | undefined)?.[0]).toMatchObject({ isUnplaced: true });

    // Bruce can't reach it: the same 404 as a batch that doesn't exist.
    const outsider = await undoBatch(bruce, batchId);
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual((await undoBatch(bruce, newId())).json());

    const res = await undoBatch(ibrahim, batchId);
    const out = ok(res) as Json & { trashed: string[] };
    expect(out.trashed.sort()).toEqual([mine1, mine2].sort());
    for (const id of [mine1, mine2]) expect((await thingRow(id))?.deleted_at).not.toBeNull();
    for (const id of [reviewed, named.id as string, louisDraft]) {
      expect((await thingRow(id))?.deleted_at).toBeNull();
    }
    const events = await auditActions(home.id, 'capture.batch_undo');
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_id).toBe(ibrahim.userId);
    const eventId = res.headers[AUDIT_EVENT_HEADER] as string;
    expect(eventId).toBeTruthy();

    // Undoing it (the audit undo route) restores them.
    ok(await undoEvent(ibrahim, eventId));
    for (const id of [mine1, mine2]) expect((await thingRow(id))?.deleted_at).toBeNull();
    // A batch with nothing of yours left to undo writes nothing.
    const none = ok(await undoBatch(talia, batchId));
    expect(none.trashed).toEqual([]);
  });

  it('undoes a single capture from its toast: the thing goes to the trash', async () => {
    const b = body(home, { name: 'Level' });
    const res = await capture(ibrahim, b);
    ok(res, 201);
    ok(await undoEvent(ibrahim, res.headers[AUDIT_EVENT_HEADER] as string));
    expect((await thingRow(b.id as string))?.deleted_at).not.toBeNull();
  });

  it("lists only the batches of locations you can see, and 'mine' only yours", async () => {
    const theirs = body(garage, { name: 'Jack' });
    ok(await capture(bruce, theirs), 201);
    const mine = ok(await call(t, '/api/v1/captures/batches?mine=1', { as: louis }));
    expect((mine.items as Json[]).every((b) => b.byMe === true)).toBe(true);
    const all = ok(await call(t, '/api/v1/captures/batches', { as: ibrahim }));
    expect((all.items as Json[]).some((b) => b.batchId === theirs.batchId)).toBe(false);
    const page = ok(await call(t, '/api/v1/captures/batches?limit=1', { as: ibrahim }));
    expect(page.items).toHaveLength(1);
    const next = ok(
      await call(t, `/api/v1/captures/batches?limit=1&cursor=${page.next_cursor}`, { as: ibrahim }),
    );
    expect((next.items as Json[])[0]?.batchId).not.toBe((page.items as Json[])[0]?.batchId);
  });
});

/** The status and body a request answered with, for the equal-answers checks. */
const answer = (res: LightMyRequestResponse) => ({ status: res.statusCode, body: res.json() });

describe('leak: the capture routes answer another household exactly as nothing', () => {
  it("treats Bruce's ids like random ids on every capture route", async () => {
    const box = (await createThing(t, bruce, garage, { name: 'Crate' })).id;
    const theirFile = await up(bruce, garage);
    const theirBatch = newId();
    ok(await capture(bruce, body(garage, { batchId: theirBatch, files: [photo(theirFile)] })), 201);

    // A capture into Home aimed at Bruce's container, file or thing.
    const cases = [
      { target: { containerId: box } },
      { files: [photo(theirFile)] },
      { attachToThingId: box, files: [photo(await up(ibrahim, home))] },
    ];
    for (const c of cases) {
      const res = await capture(ibrahim, body(home, { name: 'Probe', ...c }));
      const random = await capture(
        ibrahim,
        body(home, {
          name: 'Probe',
          ...JSON.parse(JSON.stringify(c).replaceAll(box, newId()).replaceAll(theirFile, newId())),
        }),
      );
      expect(answer(res)).toEqual(answer(random));
      expect(res.statusCode).toBe(404);
    }
    // A capture into Bruce's location.
    expect(answer(await capture(ibrahim, body(garage, { name: 'Probe' })))).toEqual(
      answer(await capture(ibrahim, body({ ...garage, id: newId() }, { name: 'Probe' }))),
    );
    // His batch and his file.
    expect(answer(await undoBatch(ibrahim, theirBatch))).toEqual(
      answer(await undoBatch(ibrahim, newId())),
    );
    const jpeg = await uniqueJpeg();
    expect(answer(await putDisplay(ibrahim, theirFile, jpeg))).toEqual(
      answer(await putDisplay(ibrahim, newId(), jpeg)),
    );
    // Nothing of his reached Home, and his batch isn't listed.
    const listed = ok(await call(t, '/api/v1/captures/batches', { as: ibrahim }));
    expect((listed.items as Json[]).some((b) => b.batchId === theirBatch)).toBe(false);
    expect(await thingRow(box)).toMatchObject({ deleted_at: null });
  });
});
