import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  fixture,
  seedPlace,
  seedThing,
  type TestFiles,
  testFiles,
  uniqueJpeg,
  upload,
} from '../../test/files.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// T17: attachments (§7.13; D115, D128, D155, D162, D177), through the front door, in the web
// contract's shapes (apps/web/src/api/inventory/types.ts AttachmentView).

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ann: Person; // owner
let dan: Person; // admin
let bob: Person; // member
let vic: Person; // viewer
let home: string;
let thing: string;

type FileView = { id: string; thumbUrl: string | null; displayUrl: string | null };
type AttachmentView = {
  id: string;
  role: string;
  sort: number;
  file: FileView | null;
  url: string | null;
  subject: Record<string, unknown>;
  createdBy: { displayName: string };
  rowVersion: number;
};

const own = <T>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query(text, values)).rows as T[]);

async function newLocation(as: Person, name: string): Promise<string> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: {
      name,
      kind: 'home',
      preset: 'household',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      rooms: [],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

async function uploaded(as: Person, locationId: string, bytes?: Buffer): Promise<string> {
  const res = await upload(t, as, locationId, bytes ?? (await uniqueJpeg()));
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as FileView).id;
}

const attach = (as: Person, body: Record<string, unknown>) =>
  call(t, '/api/v1/attachments', { as, body });

const auditActions = async (locationId: string, action: string) =>
  (await auditOf(db, locationId)).filter((e) => e.action === action);

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ann = await person(t, db, 'ann');
  dan = await person(t, db, 'dan');
  bob = await person(t, db, 'bob');
  vic = await person(t, db, 'vic');
  home = await newLocation(ann, 'Home');
  await join(db, home, dan.userId, 'admin');
  await join(db, home, bob.userId, 'member');
  await join(db, home, vic.userId, 'viewer');
  thing = await seedThing(db, home, 'Drill');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('POST /api/v1/attachments', () => {
  // catalogue: POST /api/v1/attachments
  it('attaches an upload to a thing, answers the view, and audits attachment.create', async () => {
    const fileId = await uploaded(bob, home);
    const res = await attach(bob, {
      locationId: home,
      fileId,
      subject: { thingId: thing },
      role: 'photo',
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json() as AttachmentView;
    expect(view).toMatchObject({
      role: 'photo',
      sort: 0,
      url: null,
      subject: { thingId: thing },
      createdBy: { displayName: expect.any(String) },
      rowVersion: expect.any(Number),
    });
    expect(view.file?.id).toBe(fileId);
    expect(view.file?.thumbUrl).toMatch(/^\/f\//);

    const [event] = (await auditActions(home, 'attachment.create')).slice(-1);
    expect(event?.actor_id).toBe(bob.userId);
    expect(event?.diff).toMatchObject({
      role: { after: 'photo' },
      file_id: { after: fileId },
      thing_id: { after: thing },
    });
    const subjects = await own<{ thing_id: string }>(
      `SELECT s.thing_id FROM public.audit_event_subjects s
         JOIN public.audit_events e ON e.id = s.event_id
        WHERE e.action = 'attachment.create' AND e.entity_id = $1`,
      [view.id],
    );
    expect(subjects).toEqual([{ thing_id: thing }]);
  });

  it('keeps a link as a link: never fetched, file null (D128)', async () => {
    const res = await attach(bob, {
      locationId: home,
      url: 'https://example.com/manual.pdf',
      subject: { thingId: thing },
      role: 'manual',
      sort: 3,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      url: 'https://example.com/manual.pdf',
      file: null,
      role: 'manual',
      sort: 3,
    });
  });

  it('attaches to a place, and to the location itself (D155)', async () => {
    const place = await seedPlace(db, home);
    const onPlace = await attach(bob, {
      locationId: home,
      fileId: await uploaded(bob, home),
      subject: { placeId: place },
      role: 'photo',
    });
    expect(onPlace.statusCode, onPlace.body).toBe(201);
    expect(onPlace.json()).toMatchObject({ subject: { placeId: place } });
    const onLocation = await attach(bob, {
      locationId: home,
      url: 'https://example.com/lease',
      subject: { location: true },
      role: 'document',
    });
    expect(onLocation.statusCode, onLocation.body).toBe(201);
    expect(onLocation.json()).toMatchObject({ subject: { location: true } });
  });

  it('needs exactly one of fileId and url, and an http(s) url', async () => {
    const fileId = await uploaded(bob, home);
    const base = { locationId: home, subject: { thingId: thing }, role: 'photo' };
    expect((await attach(bob, base)).statusCode).toBe(400);
    expect((await attach(bob, { ...base, fileId, url: 'https://x.test/a' })).statusCode).toBe(400);
    expect((await attach(bob, { ...base, url: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await attach(bob, { ...base, url: 'file:///etc/passwd' })).statusCode).toBe(400);
  });

  it('refuses a viewer (403) and anyone outside the location (404)', async () => {
    const body = {
      locationId: home,
      url: 'https://example.com/x',
      subject: { thingId: thing },
      role: 'document',
    };
    expect((await attach(vic, body)).statusCode).toBe(403);
    const eve = await person(t, db, 'eve');
    expect((await attach(eve, body)).statusCode).toBe(404);
  });

  it("can't attach someone else's unattached upload (it is theirs alone until attached, §7.2)", async () => {
    const annsDraft = await uploaded(ann, home);
    const res = await attach(bob, {
      locationId: home,
      fileId: annsDraft,
      subject: { thingId: thing },
      role: 'photo',
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it("can't attach a file from another location or another tenant (D177)", async () => {
    const garage = await newLocation(ann, 'Garage');
    const fromGarage = await uploaded(ann, garage);
    const cross = await attach(ann, {
      locationId: home,
      fileId: fromGarage,
      subject: { thingId: thing },
      role: 'photo',
    });
    expect(cross.statusCode, cross.body).toBe(404);

    const eve = await person(t, db, 'eve2');
    const evesFile = await uploaded(eve, eve.personalLocationId);
    const other = await attach(ann, {
      locationId: home,
      fileId: evesFile,
      subject: { thingId: thing },
      role: 'photo',
    });
    expect(other.statusCode).toBe(404);
  });

  it("refuses a subject that isn't in the location: 404", async () => {
    const garage = await newLocation(ann, 'Shed');
    const elsewhere = await seedThing(db, garage);
    const res = await attach(ann, {
      locationId: home,
      url: 'https://example.com/x',
      subject: { thingId: elsewhere },
      role: 'document',
    });
    expect(res.statusCode).toBe(404);
    const missing = await attach(ann, {
      locationId: home,
      url: 'https://example.com/x',
      subject: { thingId: newId() },
      role: 'document',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('makes the file visible to the other members once it is attached', async () => {
    const fileId = await uploaded(ann, home);
    const before = await call(t, `/api/v1/files/${fileId}/url`, {
      as: bob,
      body: { variant: 'thumb' },
    });
    expect(before.statusCode).toBe(404);
    const res = await attach(ann, {
      locationId: home,
      fileId,
      subject: { thingId: thing },
      role: 'photo',
    });
    expect(res.statusCode).toBe(201);
    const after = await call(t, `/api/v1/files/${fileId}/url`, {
      as: bob,
      body: { variant: 'thumb' },
    });
    expect(after.statusCode, after.body).toBe(200);
  });
});

describe('PATCH and DELETE /api/v1/attachments/:id', () => {
  async function bobsLink(): Promise<AttachmentView> {
    const res = await attach(bob, {
      locationId: home,
      url: `https://example.com/${newId()}`,
      subject: { thingId: thing },
      role: 'document',
    });
    expect(res.statusCode).toBe(201);
    return res.json() as AttachmentView;
  }

  const patch = (as: Person, a: AttachmentView, body: unknown, ifMatch?: number) =>
    call(t, `/api/v1/attachments/${a.id}`, {
      as,
      method: 'PATCH',
      body,
      ...(ifMatch !== undefined ? { headers: { 'if-match': String(ifMatch) } } : {}),
    });

  // catalogue: PATCH /api/v1/attachments/:id
  it('changes role and sort with If-Match, and audits attachment.update', async () => {
    const a = await bobsLink();
    expect((await patch(bob, a, { role: 'manual' })).statusCode).toBe(428);
    const stale = await patch(bob, a, { role: 'manual' }, a.rowVersion + 5);
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ conflicts: ['role'] });
    const res = await patch(bob, a, { role: 'manual', sort: 2 }, a.rowVersion);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, role: 'manual', sort: 2 });
    expect((res.json() as AttachmentView).rowVersion).toBeGreaterThan(a.rowVersion);
    const [event] = (await auditActions(home, 'attachment.update')).slice(-1);
    expect(event?.diff).toMatchObject({
      role: { before: 'document', after: 'manual' },
      sort: { before: 0, after: 2 },
    });
  });

  it('names who changed it in a 412, and lets only one of two racing PATCHes through (review #13)', async () => {
    await own('UPDATE public.user_profiles SET display_name = $2 WHERE user_id = $1', [
      ann.userId,
      'Ann Owner',
    ]);
    const a = await bobsLink();
    expect((await patch(ann, a, { sort: 5 }, a.rowVersion)).statusCode).toBe(200);
    const stale = await patch(bob, a, { sort: 6 }, a.rowVersion);
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({
      conflicts: ['sort'],
      changedBy: { displayName: 'Ann Owner' },
    });

    // Two PATCHes from the same version at once: the row is locked while it is checked, so the
    // second sees the first's version and is refused rather than silently overwriting it.
    const b = await bobsLink();
    const results = await Promise.all([
      patch(bob, b, { sort: 7 }, b.rowVersion),
      patch(bob, b, { sort: 8 }, b.rowVersion),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
  });

  it("lets a member change only their own; an admin anyone's; a viewer nothing", async () => {
    const a = await bobsLink();
    const annsRes = await attach(ann, {
      locationId: home,
      url: 'https://example.com/anns',
      subject: { thingId: thing },
      role: 'document',
    });
    const anns = annsRes.json() as AttachmentView;
    expect((await patch(bob, anns, { sort: 1 }, anns.rowVersion)).statusCode).toBe(403);
    expect((await patch(vic, a, { sort: 1 }, a.rowVersion)).statusCode).toBe(403);
    expect((await patch(dan, a, { sort: 1 }, a.rowVersion)).statusCode).toBe(200);
  });

  // catalogue: DELETE /api/v1/attachments/:id
  it('removes an attachment, own for members and any for admins, and audits attachment.delete', async () => {
    const mine = await bobsLink();
    const del = (as: Person, a: AttachmentView) =>
      call(t, `/api/v1/attachments/${a.id}`, { as, method: 'DELETE' });
    const annsRes = await attach(ann, {
      locationId: home,
      url: 'https://example.com/anns-2',
      subject: { thingId: thing },
      role: 'document',
    });
    const anns = annsRes.json() as AttachmentView;
    expect((await del(bob, anns)).statusCode).toBe(403);
    expect((await del(vic, mine)).statusCode).toBe(403);
    expect((await del(bob, mine)).statusCode).toBe(204);
    expect((await del(bob, mine)).statusCode).toBe(404);
    expect((await del(dan, anns)).statusCode).toBe(204);
    const events = await auditActions(home, 'attachment.delete');
    expect(events.map((e) => e.actor_id)).toEqual(expect.arrayContaining([bob.userId, dan.userId]));
    expect(
      await own('SELECT 1 FROM public.attachments WHERE id = ANY ($1::uuid[])', [
        [mine.id, anns.id],
      ]),
    ).toEqual([]);
  });

  it('is a 404 for anyone outside the location', async () => {
    const a = await bobsLink();
    const eve = await person(t, db, 'eve3');
    expect((await patch(eve, a, { sort: 1 }, a.rowVersion)).statusCode).toBe(404);
    expect(
      (await call(t, `/api/v1/attachments/${a.id}`, { as: eve, method: 'DELETE' })).statusCode,
    ).toBe(404);
  });
});

describe('GET …/attachments lists', () => {
  it('lists a thing’s attachments by sort, filtered by role, a page at a time', async () => {
    const drill = await seedThing(db, home, 'Saw');
    for (const [role, sort] of [
      ['photo', 2],
      ['receipt', 0],
      ['photo', 1],
    ] as const) {
      const res = await attach(bob, {
        locationId: home,
        fileId: await uploaded(bob, home),
        subject: { thingId: drill },
        role,
        sort,
      });
      expect(res.statusCode).toBe(201);
    }
    const all = await call(t, `/api/v1/things/${drill}/attachments`, { as: bob });
    expect(all.statusCode, all.body).toBe(200);
    const body = all.json() as { items: AttachmentView[]; next_cursor: string | null };
    expect(body.items.map((a) => [a.role, a.sort])).toEqual([
      ['receipt', 0],
      ['photo', 1],
      ['photo', 2],
    ]);
    // A viewer sees the previews of what is attached, but not the receipt: money is hidden from
    // viewers here, and a receipt shows it (security review #10).
    const seen = await call(t, `/api/v1/things/${drill}/attachments`, { as: vic });
    const forViewer = (seen.json() as { items: AttachmentView[] }).items;
    expect(forViewer.map((a) => [a.role, a.sort])).toEqual([
      ['photo', 1],
      ['photo', 2],
    ]);
    expect(forViewer.every((a) => a.file?.thumbUrl?.startsWith('/f/'))).toBe(true);

    const photos = await call(t, `/api/v1/things/${drill}/attachments?role=photo&limit=1`, {
      as: bob,
    });
    const p1 = photos.json() as { items: AttachmentView[]; next_cursor: string };
    expect(p1.items.map((a) => a.sort)).toEqual([1]);
    const p2 = await call(
      t,
      `/api/v1/things/${drill}/attachments?role=photo&limit=1&cursor=${p1.next_cursor}`,
      { as: bob },
    );
    expect((p2.json() as { items: AttachmentView[] }).items.map((a) => a.sort)).toEqual([2]);
  });

  it('lists a place’s and the location’s own attachments; 404 for what the caller can’t see', async () => {
    const place = await seedPlace(db, home, 'Cupboard');
    await attach(ann, {
      locationId: home,
      url: 'https://example.com/cupboard',
      subject: { placeId: place },
      role: 'document',
    });
    const onPlace = await call(t, `/api/v1/places/${place}/attachments`, { as: vic });
    expect((onPlace.json() as { items: AttachmentView[] }).items.map((a) => a.url)).toEqual([
      'https://example.com/cupboard',
    ]);
    const onLocation = await call(t, `/api/v1/locations/${home}/attachments`, { as: bob });
    expect(onLocation.statusCode, onLocation.body).toBe(200);
    for (const a of (onLocation.json() as { items: AttachmentView[] }).items) {
      expect(a.subject).toEqual({ location: true });
    }
    const eve = await person(t, db, 'eve4');
    expect((await call(t, `/api/v1/things/${thing}/attachments`, { as: eve })).statusCode).toBe(
      404,
    );
    expect((await call(t, `/api/v1/locations/${home}/attachments`, { as: eve })).statusCode).toBe(
      404,
    );
    expect(
      (await call(t, `/api/v1/purchases/${newId()}/attachments`, { as: bob })).statusCode,
    ).toBe(404);
  });
});

describe('DELETE /api/v1/files/:id: "delete original" (D162)', () => {
  // catalogue: DELETE /api/v1/files/:id
  it('lets an admin remove a mistaken upload for good, with its attachments, audited with the reason', async () => {
    const fileId = await uploaded(bob, home, await fixture('photo.jpg'));
    const a = await attach(bob, {
      locationId: home,
      fileId,
      subject: { thingId: thing },
      role: 'photo',
    });
    expect(a.statusCode).toBe(201);
    const del = (as: Person, reason = 'A photo of a passport') =>
      call(t, `/api/v1/files/${fileId}`, { as, method: 'DELETE', body: { reason } });
    expect((await del(bob)).statusCode).toBe(403);
    expect((await del(vic)).statusCode).toBe(403);
    expect((await del(dan, '  ')).statusCode).toBe(400);
    const res = await del(dan);
    expect(res.statusCode, res.body).toBe(204);
    expect(await own('SELECT 1 FROM public.files WHERE id = $1', [fileId])).toEqual([]);
    expect(await own('SELECT 1 FROM public.file_derivatives WHERE file_id = $1', [fileId])).toEqual(
      [],
    );
    expect(
      await own('SELECT 1 FROM public.attachments WHERE id = $1', [
        (a.json() as AttachmentView).id,
      ]),
    ).toEqual([]);
    const [event] = await auditActions(home, 'file.delete_original');
    expect(event?.actor_id).toBe(dan.userId);
    expect(event?.diff).toMatchObject({ reason: { before: null, after: 'A photo of a passport' } });
    expect((await del(dan)).statusCode).toBe(404);
  });

  it('deletes the blobs after the commit, keeping those a cross-account copy still shares (D161)', async () => {
    const keysOf = async (fileId: string) =>
      (
        await own<{ key: string }>(
          `SELECT storage_key AS key FROM public.files WHERE id = $1
           UNION ALL SELECT storage_key FROM public.file_derivatives WHERE file_id = $1`,
          [fileId],
        )
      ).map((r) => r.key);
    const present = (keys: string[]) => Promise.all(keys.map((k) => files.blobs.exists(k)));
    const del = (fileId: string) =>
      call(t, `/api/v1/files/${fileId}`, {
        as: dan,
        method: 'DELETE',
        body: { reason: 'Uploaded by mistake' },
      });

    // Attached, so the admin sees them (an unattached upload is its uploader's alone).
    const photo = async () => {
      const fileId = await uploaded(bob, home);
      const a = await attach(bob, {
        locationId: home,
        fileId,
        subject: { thingId: thing },
        role: 'photo',
      });
      expect(a.statusCode, a.body).toBe(201);
      return fileId;
    };

    // A photo alone: its original and every derivative go.
    const lone = await photo();
    const loneKeys = await keysOf(lone);
    expect(loneKeys.length).toBeGreaterThan(1);
    expect(await present(loneKeys)).toEqual(loneKeys.map(() => true));
    const audits = (await auditActions(home, 'file.delete_original')).length;
    expect((await del(lone)).statusCode).toBe(204);
    expect(await present(loneKeys)).toEqual(loneKeys.map(() => false));
    expect(await auditActions(home, 'file.delete_original')).toHaveLength(audits + 1);

    // A photo a cross-account move copied into another account's location: the copy names the
    // same blobs, so deleting the original here keeps them for the copy.
    const elsewhere = await newLocation(vic, 'Vic flat');
    const shared = await photo();
    const sharedKeys = await keysOf(shared);
    const [copy] = await own<{ id: string }>('SELECT kept.copy_file($1, $2) AS id', [
      shared,
      elsewhere,
    ]);
    expect(copy?.id).not.toBe(shared);
    expect((await keysOf(copy?.id ?? '')).sort()).toEqual([...sharedKeys].sort());
    expect((await del(shared)).statusCode).toBe(204);
    expect(await present(sharedKeys)).toEqual(sharedKeys.map(() => true));
  });
});
