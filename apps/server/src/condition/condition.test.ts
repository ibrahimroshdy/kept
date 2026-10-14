import { execFileSync } from 'node:child_process';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import {
  createLocation,
  eventsOf,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import { withScope } from '../db/scope.js';
import { runJob } from '../jobs/boss.js';
import { reportJobs } from '../reports/jobs.js';

// Renters' condition reports (1.x, D171, D235), through the front door: starting a report from
// the location's rooms, recording each room and its photos, finishing (and the lock that
// follows, in the routes and in the database), deleting, and the PDF, alone and side by side.
//
// Ibrahim owns Flat. Bruce is an admin there, Louis a member and Talia a viewer. Ibrahim also owns
// Garage, which none of the others can see.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let flat: Loc;
let garage: Loc;
let kitchen: string;
let bedroom: string;

const hasPoppler = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();
const pdfText = (pdf: Buffer) =>
  execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], {
    input: pdf,
    timeout: 30_000,
  }).toString('utf8');

const log = { info: () => {}, error: () => {} };

type Room = {
  id: string;
  placeId: string | null;
  name: string;
  condition: string | null;
  note: string | null;
  photos: { id: string; addedAt: string; file: { id: string } | null }[];
  rowVersion: number;
};
type Report = {
  id: string;
  kind: string;
  heldOn: string;
  finishedAt: string | null;
  finishedBy: { displayName: string } | null;
  rooms: Room[];
  others: { id: string }[];
  rowVersion: number;
  photoCount: number;
};

const start = async (as: Person, body: object, loc = flat) =>
  ok(
    await call(t, `/api/v1/locations/${loc.id}/condition-reports`, { as, body }),
    201,
  ) as unknown as Report;
const read = async (as: Person, id: string) =>
  ok(await call(t, `/api/v1/condition-reports/${id}`, { as })) as unknown as Report;
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });

async function photo(as: Person, roomId: string, role = 'photo') {
  const up = ok(await upload(t, as, flat.id, await uniqueJpeg()), 201);
  return call(t, '/api/v1/attachments', {
    as,
    body: {
      id: newId(),
      locationId: flat.id,
      fileId: up.id,
      subject: { conditionRoomId: roomId },
      role,
    },
  });
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  flat = await createLocation(t, db, ibrahim, 'household', 'Flat');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, flat.id, bruce.userId, 'admin');
  await join(db, flat.id, louis.userId, 'member');
  await join(db, flat.id, talia.userId, 'viewer');
  kitchen = await place(db, flat, 'Kitchen');
  bedroom = await place(db, flat, 'Bedroom');
  // A shelf in the kitchen isn't a room.
  await own(db, "UPDATE public.places SET kind_key = 'zone' WHERE id = $1", [
    await place(db, flat, 'Spice shelf', kitchen),
  ]);
});

afterAll(async () => {
  await files?.cleanup();
});

describe('starting and recording a report', () => {
  let report: Report;

  // catalogue: POST /api/v1/locations/:id/condition-reports
  it('starts with the location’s rooms, audits condition_report.create, and refuses a viewer', async () => {
    report = await start(louis, { kind: 'move_in', heldOn: '2026-09-01', notes: 'Keys: 2' });
    const names = report.rooms.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Kitchen', 'Bedroom']));
    expect(names).not.toContain('Spice shelf');
    expect(names).not.toContain('Unplaced');
    expect(report.rooms.find((r) => r.name === 'Kitchen')?.placeId).toBe(kitchen);
    const events = await eventsOf(db, flat.id, report.id);
    expect(events.map((e) => e.action)).toEqual(['condition_report.create']);
    expect(events[0]?.diff.kind).toMatchObject({ after: 'move_in' });

    const refused = await call(t, `/api/v1/locations/${flat.id}/condition-reports`, {
      as: talia,
      body: { kind: 'move_in', heldOn: '2026-09-01' },
    });
    expect(refused.statusCode).toBe(403);
    const hidden = await call(t, `/api/v1/locations/${garage.id}/condition-reports`, {
      as: louis,
      body: { kind: 'move_in', heldOn: '2026-09-01' },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('lets everyone who sees the location read it, and no one else', async () => {
    expect((await read(talia, report.id)).id).toBe(report.id);
    const list = ok(
      await call(t, `/api/v1/condition-reports?locationId=${flat.id}&state=open`, { as: talia }),
    );
    expect((list.items as { id: string }[]).map((r) => r.id)).toContain(report.id);
    const outsider = await person(t, db, 'outsider');
    expect(
      (await call(t, `/api/v1/condition-reports/${report.id}`, { as: outsider })).statusCode,
    ).toBe(404);
  });

  // catalogue: PATCH /api/v1/condition-reports/:id
  it('changes the day and notes under If-Match, audited condition_report.update', async () => {
    const res = await call(t, `/api/v1/condition-reports/${report.id}`, {
      method: 'PATCH',
      as: louis,
      headers: ifMatch(report.rowVersion),
      body: { heldOn: '2026-09-02', notes: null },
    });
    report = ok(res) as unknown as Report;
    expect(report.heldOn).toBe('2026-09-02');
    const stale = await call(t, `/api/v1/condition-reports/${report.id}`, {
      method: 'PATCH',
      as: louis,
      headers: ifMatch(1),
      body: { notes: 'late' },
    });
    expect(stale.statusCode).toBe(412);
    const events = await eventsOf(db, flat.id, report.id);
    expect(events.at(-1)?.action).toBe('condition_report.update');
    expect(events.at(-1)?.diff.held_on).toMatchObject({
      before: '2026-09-01',
      after: '2026-09-02',
    });
  });

  // catalogue: POST /api/v1/condition-reports/:id/rooms
  it('adds a room by name or by place, once per place, audited condition_room.create', async () => {
    const balcony = ok(
      await call(t, `/api/v1/condition-reports/${report.id}/rooms`, {
        as: louis,
        body: { name: 'Balcony' },
      }),
      201,
    ) as unknown as Room;
    expect(balcony).toMatchObject({ name: 'Balcony', placeId: null, condition: null });
    const again = await call(t, `/api/v1/condition-reports/${report.id}/rooms`, {
      as: louis,
      body: { placeId: kitchen },
    });
    expect(again.statusCode).toBe(409);
    const events = await eventsOf(db, flat.id, balcony.id);
    expect(events.map((e) => e.action)).toEqual(['condition_room.create']);
  });

  // catalogue: PATCH /api/v1/condition-rooms/:id
  it('records a room’s condition and note, audited condition_room.update', async () => {
    const room = (await read(louis, report.id)).rooms.find((r) => r.placeId === kitchen) as Room;
    const res = await call(t, `/api/v1/condition-rooms/${room.id}`, {
      method: 'PATCH',
      as: louis,
      headers: ifMatch(room.rowVersion),
      body: { condition: 'fair', note: 'Chip in the worktop by the sink' },
    });
    expect(ok(res)).toMatchObject({ condition: 'fair', note: 'Chip in the worktop by the sink' });
    const viewer = await call(t, `/api/v1/condition-rooms/${room.id}`, {
      method: 'PATCH',
      as: talia,
      headers: ifMatch(room.rowVersion + 1),
      body: { condition: 'good' },
    });
    expect(viewer.statusCode).toBe(403);
    const events = await eventsOf(db, flat.id, room.id);
    expect(events.map((e) => e.action)).toEqual(['condition_room.update']);
    expect(events[0]?.diff.condition).toMatchObject({ before: null, after: 'fair' });
  });

  // catalogue: DELETE /api/v1/condition-rooms/:id
  it('removes a room, audited condition_room.delete', async () => {
    const balcony = (await read(louis, report.id)).rooms.find((r) => r.name === 'Balcony') as Room;
    const res = await call(t, `/api/v1/condition-rooms/${balcony.id}`, {
      method: 'DELETE',
      as: louis,
      headers: ifMatch(balcony.rowVersion),
    });
    expect(res.statusCode).toBe(204);
    const events = await eventsOf(db, flat.id, balcony.id);
    expect(events.at(-1)?.action).toBe('condition_room.delete');
  });

  it('takes photos on a room, dated by when Kept received them, and nothing else', async () => {
    const room = (await read(louis, report.id)).rooms.find((r) => r.placeId === kitchen) as Room;
    ok(await photo(louis, room.id), 201);
    const notPhoto = await photo(louis, room.id, 'document');
    expect(notPhoto.statusCode).toBe(400);
    const after = (await read(talia, report.id)).rooms.find((r) => r.id === room.id) as Room;
    expect(after.photos).toHaveLength(1);
    expect(Date.parse(after.photos[0]?.addedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('finishing a report', () => {
  let report: Report;
  let room: Room;
  let photoId: string;

  beforeAll(async () => {
    report = await start(louis, { kind: 'move_in', heldOn: '2026-09-05' });
    room = report.rooms.find((r) => r.placeId === bedroom) as Room;
    photoId = ok(await photo(louis, room.id), 201).id;
  });

  // catalogue: POST /api/v1/condition-reports/:id/finish
  it('stamps who and when, audited condition_report.finish', async () => {
    const res = await call(t, `/api/v1/condition-reports/${report.id}/finish`, {
      method: 'POST',
      as: louis,
      headers: ifMatch(report.rowVersion),
    });
    report = ok(res) as unknown as Report;
    expect(report.finishedAt).not.toBeNull();
    expect(report.finishedBy).toEqual({ displayName: 'Louis' });
    const events = await eventsOf(db, flat.id, report.id);
    expect(events.at(-1)?.action).toBe('condition_report.finish');
  });

  it('locks the report, its rooms and their photos, with a reason', async () => {
    const patch = await call(t, `/api/v1/condition-reports/${report.id}`, {
      method: 'PATCH',
      as: bruce,
      headers: ifMatch(report.rowVersion),
      body: { notes: 'after the fact' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toMatchObject({ reason: 'report_finished' });
    const fresh = (await read(louis, report.id)).rooms.find((r) => r.id === room.id) as Room;
    const roomPatch = await call(t, `/api/v1/condition-rooms/${room.id}`, {
      method: 'PATCH',
      as: louis,
      headers: ifMatch(fresh.rowVersion),
      body: { condition: 'damaged' },
    });
    expect(roomPatch.statusCode).toBe(409);
    expect(
      (
        await call(t, `/api/v1/condition-reports/${report.id}/rooms`, {
          as: louis,
          body: { name: 'Hall' },
        })
      ).statusCode,
    ).toBe(409);
    expect((await photo(louis, room.id)).statusCode).toBe(409);
    const remove = await call(t, `/api/v1/attachments/${photoId}`, { method: 'DELETE', as: bruce });
    expect(remove.statusCode).toBe(409);
  });

  it('holds in the database too: the policies and the photo trigger refuse kept_app', async () => {
    const scope = { userId: bruce.userId, mfa: false };
    const changed = await withScope(db.pools.app, scope, async (_tx, c) => {
      const a = await c.query("UPDATE public.condition_reports SET notes = 'x' WHERE id = $1", [
        report.id,
      ]);
      const b = await c.query(
        "UPDATE public.condition_report_rooms SET note = 'x' WHERE report_id = $1",
        [report.id],
      );
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    });
    expect(changed).toBe(0);
    await expect(
      withScope(db.pools.app, scope, (_tx, c) =>
        c.query('DELETE FROM public.attachments WHERE id = $1', [photoId]),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'condition_report_finished' });
  });

  // catalogue: DELETE /api/v1/condition-reports/:id
  it('is deleted only by owners and admins once finished; a draft by any writer', async () => {
    const member = await call(t, `/api/v1/condition-reports/${report.id}`, {
      method: 'DELETE',
      as: louis,
      headers: ifMatch(report.rowVersion),
    });
    expect(member.statusCode).toBe(403);
    const admin = await call(t, `/api/v1/condition-reports/${report.id}`, {
      method: 'DELETE',
      as: bruce,
      headers: ifMatch(report.rowVersion),
    });
    expect(admin.statusCode).toBe(204);
    const events = await eventsOf(db, flat.id, report.id);
    expect(events.at(-1)?.action).toBe('condition_report.delete');
    const left = await own<{ n: number }>(
      db,
      'SELECT count(*)::int AS n FROM public.attachments WHERE id = $1',
      [photoId],
    );
    expect(left[0]?.n).toBe(0);

    const draft = await start(louis, { kind: 'move_out', heldOn: '2026-09-06' });
    const gone = await call(t, `/api/v1/condition-reports/${draft.id}`, {
      method: 'DELETE',
      as: louis,
      headers: ifMatch(draft.rowVersion),
    });
    expect(gone.statusCode).toBe(204);
  });
});

describe('the PDF', () => {
  let moveIn: Report;
  let moveOut: Report;

  beforeAll(async () => {
    moveIn = await start(louis, { kind: 'move_in', heldOn: '2026-01-10' });
    const kitchenIn = moveIn.rooms.find((r) => r.placeId === kitchen) as Room;
    ok(
      await call(t, `/api/v1/condition-rooms/${kitchenIn.id}`, {
        method: 'PATCH',
        as: louis,
        headers: ifMatch(kitchenIn.rowVersion),
        body: { condition: 'good', note: 'Oven clean' },
      }),
    );
    ok(await photo(louis, kitchenIn.id), 201);
    moveOut = await start(louis, { kind: 'move_out', heldOn: '2026-10-10' });
    const kitchenOut = moveOut.rooms.find((r) => r.placeId === kitchen) as Room;
    ok(
      await call(t, `/api/v1/condition-rooms/${kitchenOut.id}`, {
        method: 'PATCH',
        as: louis,
        headers: ifMatch(kitchenOut.rowVersion),
        body: { condition: 'damaged', note: 'Burn mark on the worktop' },
      }),
    );
  });

  it('names the other kind’s reports to compare with', async () => {
    const view = await read(talia, moveOut.id);
    expect(view.others.map((o) => o.id)).toContain(moveIn.id);
    expect(view.others.map((o) => o.id)).not.toContain(moveOut.id);
  });

  // catalogue: POST /api/v1/reports/condition
  it('queues a run for a viewer, audits report.generate, and refuses another location’s report', async () => {
    sent.length = 0;
    const body = ok(
      await call(t, '/api/v1/reports/condition', {
        as: talia,
        body: { reportId: moveOut.id, compareWith: moveIn.id },
      }),
      202,
    );
    expect(sent).toEqual([{ name: 'report', data: { runId: body.id } }]);
    const events = await own<{ action: string; diff: Record<string, { after: unknown }> }>(
      db,
      `SELECT action, diff FROM public.audit_events WHERE entity_type = 'report' AND entity_id = $1`,
      [body.id],
    );
    expect(events.map((e) => e.action)).toEqual(['report.generate']);
    expect(events[0]?.diff.kind?.after).toBe('condition');

    const elsewhere = await start(ibrahim, { kind: 'move_in', heldOn: '2026-01-01' }, garage);
    const mixed = await call(t, '/api/v1/reports/condition', {
      as: ibrahim,
      body: { reportId: moveOut.id, compareWith: elsewhere.id },
    });
    expect(mixed.statusCode).toBe(404);
  });

  it.skipIf(!hasPoppler)(
    'prints both walk-throughs room by room, the earlier first',
    async () => {
      const { id } = ok(
        await call(t, '/api/v1/reports/condition', {
          as: louis,
          body: { reportId: moveOut.id, compareWith: moveIn.id, locale: 'en' },
        }),
        202,
      );
      const job = reportJobs({
        pools: db.pools,
        mailer: { send: async () => {} },
        publicUrl: 'https://kept.example',
        log,
        files,
      }).find((j) => j.name === 'report');
      if (!job) throw new Error('no report job');
      await runJob(job, { userId: louis.userId, mfa: false, data: { runId: id } }, db.pools);
      const run = ok(await call(t, `/api/v1/reports/${id}`, { as: louis })) as {
        status?: string;
        fileUrl?: string;
      };
      expect(run.status, JSON.stringify(run)).toBe('done');
      const res = await t.app.inject({ method: 'GET', url: run.fileUrl as string });
      expect(String(res.headers['content-disposition'])).toMatch(/kept-condition-report-/);
      const text = pdfText(res.rawPayload);
      expect(text).toContain('Condition report');
      expect(text).toContain('Kitchen');
      expect(text).toContain('Burn mark on the worktop');
      expect(text).toContain('Oven clean');
      expect(text).toContain('Damaged');
      expect(text).toContain('Not finished');
      expect(text.indexOf('Move-in')).toBeLessThan(text.indexOf('Move-out'));
    },
    60_000,
  );
});
