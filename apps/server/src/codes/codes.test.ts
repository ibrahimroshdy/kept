import { legacyCodeKey } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  createLocation,
  createThing,
  eventsOf,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';
import { vetRule } from './format-rule.js';

// T17a (D208): own codes through the front door. Ibrahim owns Home and Garage; in Home, Bruce is
// an admin, Louis a member and Talia a viewer.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let home: Loc;
let garage: Loc;

const codes = (as: Person, kind: 'things' | 'places', id: string) =>
  call(t, `/api/v1/${kind}/${id}/codes`, { as });
const add = (as: Person, kind: 'things' | 'places', id: string, body: object) =>
  call(t, `/api/v1/${kind}/${id}/codes`, { as, body });
const rename = (as: Person, id: string, code: string, to: string) =>
  call(t, `/api/v1/things/${id}/codes/${encodeURIComponent(code)}`, {
    as,
    method: 'PUT',
    body: { code: to },
  });
const remove = (as: Person, kind: 'things' | 'places', id: string, code: string) =>
  call(t, `/api/v1/${kind}/${id}/codes/${encodeURIComponent(code)}`, { as, method: 'DELETE' });
const settings = (as: Person, loc: Loc) => call(t, `/api/v1/locations/${loc.id}/own-codes`, { as });
async function setSettings(as: Person, loc: Loc, body: object) {
  const current = ok(await settings(as, loc));
  return call(t, `/api/v1/locations/${loc.id}/own-codes`, {
    as,
    method: 'PUT',
    body,
    headers: { 'if-match': String(current.rowVersion) },
  });
}
const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });
const ownCodes = async (thingId: string) =>
  (
    await own<{ code: string }>(
      db,
      `SELECT code FROM public.legacy_codes WHERE thing_id = $1 AND source = 'own' ORDER BY code`,
      [thingId],
    )
  ).map((r) => r.code);

const NUMBERING_OFF = { numbering: { enabled: false, prefix: '', pad: 4 }, rule: null };

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
});

afterAll(async () => {
  await t.app.close();
});

describe('own codes on a thing or a place', () => {
  // catalogue: POST /api/v1/things/:id/codes
  it('adds several codes to a thing, stored as typed codes are (upper case, trimmed), audited and undoable', async () => {
    const drill = await createThing(t, louis, home, { name: 'Drill' });
    const first = await add(louis, 'things', drill.id, { code: ' home-0042 ' });
    expect(ok(first, 201)).toEqual({ code: 'HOME-0042' });
    expect(first.headers['x-kept-audit-event']).toBeTruthy();
    ok(await add(louis, 'things', drill.id, { code: 'Asset ٧' }), 201);
    expect(ok(await codes(talia, 'things', drill.id))).toEqual({
      codes: [
        { code: 'ASSET 7', source: 'own', sourceCollection: '' },
        { code: 'HOME-0042', source: 'own', sourceCollection: '' },
      ],
    });
    const events = (await eventsOf(db, home.id, drill.id)).filter(
      (e) => e.action === 'thing.codes',
    );
    expect(events.map((e) => e.diff.own_codes)).toEqual([
      { before: [], after: ['HOME-0042'], class: 'plain' },
      { before: ['HOME-0042'], after: ['ASSET 7', 'HOME-0042'], class: 'plain' },
    ]);
    expect(events.every((e) => e.undoable_until !== null)).toBe(true);
    // Undo the second add: the list goes back.
    const res = await undo(louis, events[1]?.id as string);
    expect(res.statusCode, res.body).toBe(200);
    expect(await ownCodes(drill.id)).toEqual(['HOME-0042']);
  });

  // catalogue: POST /api/v1/places/:id/codes
  it('adds a code to a place too; a duplicate in the same location is 409, another location is fine', async () => {
    const shelf = await place(db, home, 'Shelf');
    const res = await add(bruce, 'places', shelf, { code: 'SHELF-1' });
    expect(ok(res, 201)).toEqual({ code: 'SHELF-1' });
    const events = (await eventsOf(db, home.id, shelf)).filter((e) => e.action === 'place.codes');
    expect(events.at(-1)?.diff.own_codes).toMatchObject({ after: ['SHELF-1'] });

    const lamp = await createThing(t, ibrahim, home, { name: 'Lamp' });
    const dup = await add(ibrahim, 'things', lamp.id, { code: 'shelf-1' });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'conflict', taken: { kind: 'place', id: shelf } });
    // Any source counts: a CSV import's old code in the location is taken too.
    await own(
      db,
      `INSERT INTO public.legacy_codes (location_id, source, code, thing_id) VALUES ($1, 'csv', 'OLD-1', $2)`,
      [home.id, lamp.id],
    );
    expect((await add(ibrahim, 'things', lamp.id, { code: 'old-1' })).statusCode).toBe(409);

    const jack = await createThing(t, ibrahim, garage, { name: 'Jack' });
    ok(await add(ibrahim, 'things', jack.id, { code: 'SHELF-1' }), 201);
  });

  // catalogue: PUT /api/v1/things/:id/codes/:code
  it('renames a code (audited, undoable); a code that is not the thing’s own is 404', async () => {
    const saw = await createThing(t, ibrahim, home, { name: 'Saw' });
    ok(await add(ibrahim, 'things', saw.id, { code: 'SAW-1' }), 201);
    const res = await rename(ibrahim, saw.id, 'saw-1', 'SAW-2');
    expect(ok(res)).toEqual({ code: 'SAW-2' });
    expect(await ownCodes(saw.id)).toEqual(['SAW-2']);
    const events = (await eventsOf(db, home.id, saw.id)).filter((e) => e.action === 'thing.codes');
    expect(events.at(-1)?.diff.own_codes).toMatchObject({ before: ['SAW-1'], after: ['SAW-2'] });
    expect((await rename(ibrahim, saw.id, 'NOPE', 'X')).statusCode).toBe(404);
    ok(await undo(ibrahim, res.headers['x-kept-audit-event'] as string));
    expect(await ownCodes(saw.id)).toEqual(['SAW-1']);
  });

  // catalogue: DELETE /api/v1/things/:id/codes/:code
  it('removes a code (audited), and the snapshot sends its removal by its key', async () => {
    const vice = await createThing(t, ibrahim, home, { name: 'Vice' });
    ok(await add(ibrahim, 'things', vice.id, { code: 'VICE-1' }), 201);
    // A full pass, to hold a cursor.
    let cursor: string | null = null;
    for (;;) {
      const qs: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = ok(await call(t, `/api/v1/sync/snapshot${qs}`, { as: ibrahim }));
      cursor = page.nextCursor as string;
      if (page.complete) break;
    }
    const res = await remove(ibrahim, 'things', vice.id, 'vice-1');
    expect(res.statusCode, res.body).toBe(204);
    expect(await ownCodes(vice.id)).toEqual([]);
    const events = (await eventsOf(db, home.id, vice.id)).filter((e) => e.action === 'thing.codes');
    expect(events.at(-1)?.diff.own_codes).toMatchObject({ before: ['VICE-1'], after: [] });
    const delta = ok(
      await call(t, `/api/v1/sync/snapshot?cursor=${encodeURIComponent(cursor as string)}`, {
        as: ibrahim,
      }),
    );
    const key = legacyCodeKey({
      locationId: home.id,
      source: 'own',
      sourceCollection: '',
      code: 'VICE-1',
    });
    expect(delta.removed).toContainEqual({
      locationId: home.id,
      entityType: 'legacy_code',
      entityId: key,
    });
    // Adding it back clears the tombstone: the next delta carries the code, not its removal.
    ok(await add(ibrahim, 'things', vice.id, { code: 'VICE-1' }), 201);
    const again = ok(
      await call(
        t,
        `/api/v1/sync/snapshot?cursor=${encodeURIComponent(delta.nextCursor as string)}`,
        {
          as: ibrahim,
        },
      ),
    );
    expect(again.removed).not.toContainEqual(expect.objectContaining({ entityId: key }));
    expect((again.changes as { legacyCodes: { code: string }[] }).legacyCodes).toContainEqual(
      expect.objectContaining({ code: 'VICE-1', thingId: vice.id }),
    );
  });

  // catalogue: PUT /api/v1/places/:id/codes/:code
  // catalogue: DELETE /api/v1/places/:id/codes/:code
  it('renames and removes a place’s code, each audited', async () => {
    const hall = await place(db, home, 'Hall');
    ok(await add(bruce, 'places', hall, { code: 'HALL-1' }), 201);
    const url = `/api/v1/places/${hall}/codes`;
    ok(await call(t, `${url}/HALL-1`, { as: bruce, method: 'PUT', body: { code: 'HALL-2' } }));
    const gone = await call(t, `${url}/HALL-2`, { as: bruce, method: 'DELETE' });
    expect(gone.statusCode, gone.body).toBe(204);
    const events = (await eventsOf(db, home.id, hall)).filter((e) => e.action === 'place.codes');
    expect(events.map((e) => e.diff.own_codes)).toEqual([
      { before: [], after: ['HALL-1'], class: 'plain' },
      { before: ['HALL-1'], after: ['HALL-2'], class: 'plain' },
      { before: ['HALL-2'], after: [], class: 'plain' },
    ]);
  });

  it('a viewer can’t add, rename or remove a code (403); another household’s thing is 404', async () => {
    const box = await createThing(t, ibrahim, home, { name: 'Box' });
    ok(await add(ibrahim, 'things', box.id, { code: 'BOX-1' }), 201);
    expect((await add(talia, 'things', box.id, { code: 'BOX-2' })).statusCode).toBe(403);
    expect((await rename(talia, box.id, 'BOX-1', 'BOX-3')).statusCode).toBe(403);
    expect((await remove(talia, 'things', box.id, 'BOX-1')).statusCode).toBe(403);
    expect((await codes(talia, 'things', box.id)).statusCode).toBe(200);
    const stranger = await person(t, db, 'peter');
    expect((await codes(stranger, 'things', box.id)).statusCode).toBe(404);
    expect((await add(stranger, 'things', box.id, { code: 'BOX-9' })).statusCode).toBe(404);
  });

  it('scanning an own code resolves it, as typed or scanned, and search finds it', async () => {
    const kettle = await createThing(t, ibrahim, home, { name: 'Kettle' });
    ok(await add(ibrahim, 'things', kettle.id, { code: 'KIT-0007' }), 201);
    for (const text of ['KIT-0007', ' kit-0007 ']) {
      expect(ok(await call(t, '/api/v1/scan/resolve', { as: talia, body: { text } }))).toEqual({
        outcome: 'open',
        target: { kind: 'thing', id: kettle.id, locationId: home.id },
      });
    }
    const found = ok(
      await call(t, `/api/v1/search?q=kit-0007&locationId=${home.id}`, { as: talia }),
    );
    expect(JSON.stringify(found)).toContain(kettle.id);
  });
});

describe('numbering and the format rule', () => {
  // catalogue: PUT /api/v1/locations/:locationId/own-codes
  it('owners and admins set the options (audited); a member is 403 and a stale If-Match 412', async () => {
    expect(ok(await settings(louis, home))).toMatchObject({
      numbering: { enabled: false, prefix: '', pad: 4, next: '0001' },
      rule: null,
      rowVersion: 0,
    });
    expect((await setSettings(louis, home, NUMBERING_OFF)).statusCode).toBe(403);
    const res = await setSettings(bruce, home, {
      numbering: { enabled: false, prefix: 'home-', pad: 4 },
      rule: null,
    });
    expect(ok(res)).toMatchObject({ numbering: { prefix: 'HOME-', next: 'HOME-0001' } });
    const stale = await call(t, `/api/v1/locations/${home.id}/own-codes`, {
      as: bruce,
      method: 'PUT',
      body: NUMBERING_OFF,
      headers: { 'if-match': '0' },
    });
    expect(stale.statusCode).toBe(412);
    const events = await own<{ action: string; diff: Record<string, unknown> }>(
      db,
      `SELECT action, diff FROM public.audit_events
        WHERE location_id = $1 AND action = 'location.own_codes' ORDER BY at`,
      [home.id],
    );
    expect(events.at(-1)?.diff).toMatchObject({ prefix: { after: 'HOME-' } });
  });

  it('numbers new things gap-free under 20 parallel creates, and never reuses a deleted number', async () => {
    ok(
      await setSettings(ibrahim, garage, {
        numbering: { enabled: true, prefix: 'GAR-', pad: 4 },
        rule: null,
      }),
    );
    const made = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createThing(t, ibrahim, garage, { name: `Bolt ${i}` })),
    );
    const numbers = await own<{ code: string }>(
      db,
      `SELECT g.code FROM public.legacy_codes g
        WHERE g.thing_id = ANY ($1::uuid[]) AND g.source = 'own' ORDER BY g.code`,
      [made.map((m) => m.id)],
    );
    expect(numbers.map((r) => r.code)).toEqual(
      Array.from({ length: 20 }, (_, i) => `GAR-${String(i + 1).padStart(4, '0')}`),
    );
    // The last one's code is deleted; the next thing still gets GAR-0021.
    const last = made.find((m) => m.name === 'Bolt 0') as { id: string };
    const lastCode = (await ownCodes(last.id))[0] as string;
    expect((await remove(ibrahim, 'things', last.id, lastCode)).statusCode).toBe(204);
    const next = await createThing(t, ibrahim, garage, { name: 'Nut' });
    expect(await ownCodes(next.id)).toEqual(['GAR-0021']);
    // POST /things answers with the number the commit gave it, and each parallel one with its own.
    expect(next.ownCodes).toEqual(['GAR-0021']);
    expect(made.map((m) => m.ownCodes).sort()).toEqual(numbers.map((r) => [r.code]));
    // A duplicate answers its own number too (T19).
    const copy = ok(
      await call(t, `/api/v1/things/${next.id}/duplicate`, { as: ibrahim, body: {} }),
      201,
    );
    expect(copy.ownCodes).toEqual(['GAR-0022']);
    // "Next number" on an existing place takes the one after.
    const bench = await place(db, garage, 'Bench');
    expect(ok(await add(ibrahim, 'places', bench, { next: true }), 201)).toEqual({
      code: 'GAR-0023',
    });
    // With numbering off, "next" is 409, and a new thing has no own code.
    ok(await setSettings(ibrahim, garage, NUMBERING_OFF));
    expect((await add(ibrahim, 'places', bench, { next: true })).statusCode).toBe(409);
    expect((await createThing(t, ibrahim, garage, { name: 'Washer' })).ownCodes).toEqual([]);
  });

  it('refuses a catastrophic pattern, one that won’t compile, and an example that doesn’t match', async () => {
    const slow = await setSettings(bruce, home, {
      numbering: { enabled: false, prefix: '', pad: 4 },
      rule: { pattern: '(a+)+$', message: 'Letters only.', example: 'AAA' },
    });
    expect(slow.statusCode, slow.body).toBe(400);
    expect(slow.json()).toMatchObject({ code: 'validation', reason: 'slow' });
    expect(vetRule({ pattern: '(a+)+$', message: 'x', example: 'A' })).toMatchObject({
      ok: false,
      reason: 'slow',
    });
    const broken = await setSettings(bruce, home, {
      ...NUMBERING_OFF,
      rule: { pattern: 'a)|(b', message: 'x', example: 'A' },
    });
    expect(broken.json()).toMatchObject({ code: 'validation', reason: 'invalid' });
    const example = await setSettings(bruce, home, {
      ...NUMBERING_OFF,
      rule: { pattern: 'HOME-[0-9]{4}', message: 'x', example: 'GAR-1' },
    });
    expect(example.json()).toMatchObject({ code: 'validation', reason: 'example' });
  });

  it('a code failing the rule is 400 with the owner’s message; a rule change rewrites nothing and lists what no longer matches', async () => {
    const tv = await createThing(t, ibrahim, home, { name: 'TV' });
    ok(await add(ibrahim, 'things', tv.id, { code: 'TV1' }), 201);
    ok(
      await setSettings(bruce, home, {
        ...NUMBERING_OFF,
        rule: {
          pattern: 'HOME-[0-9]{4}',
          message: 'Use HOME- and four digits, like the stickers.',
          example: 'HOME-0001',
        },
      }),
    );
    const bad = await add(ibrahim, 'things', tv.id, { code: 'TV2' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      code: 'validation',
      hint: 'Use HOME- and four digits, like the stickers.',
      rule: { example: 'HOME-0001' },
    });
    ok(await add(ibrahim, 'things', tv.id, { code: 'home-0100' }), 201);
    expect(await ownCodes(tv.id)).toEqual(['HOME-0100', 'TV1']);
    const list = ok(
      await call(t, `/api/v1/locations/${home.id}/own-codes/mismatches`, { as: louis }),
    );
    expect(list.items).toContainEqual({
      code: 'TV1',
      kind: 'thing',
      id: tv.id,
      name: 'TV',
      reason: 'mismatch',
    });
    expect(JSON.stringify(list.items)).not.toContain('HOME-0100');
    // Numbering whose codes would break the rule is refused.
    const clash = await setSettings(bruce, home, {
      numbering: { enabled: true, prefix: 'X-', pad: 2 },
      rule: { pattern: 'HOME-[0-9]{4}', message: 'm', example: 'HOME-0001' },
    });
    expect(clash.json()).toMatchObject({ code: 'validation', reason: 'numbering' });
    ok(await setSettings(bruce, home, NUMBERING_OFF));
  });
});
