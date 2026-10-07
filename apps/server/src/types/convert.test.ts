import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { newId } from '@kept/shared';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Json, type Loc, ok, own } from '../../test/things.js';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import { createLogger } from '../http/logger.js';

// Step-7 T18 through the front door, as the web calls it (apps/web/src/api/portability/
// {types,paths}.ts, components/registries/convert-field-sheet): a field made secret, plain again,
// or another kind, previewed per location (D172, D177, plan Q20), owner only, in one transaction;
// no value in the response, the audit or a log line.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDb;
let t: TestApp;
const logLines: string[] = [];

let alfred: Person; // owns بيت العائلة and his Garage
let bruce: Person; // admin of بيت العائلة, not the account owner
let ibrahim: Person; // nothing of Alfred's
let familyHome: Loc; // complete: Secrets on
let garage: Loc; // essentials
let doorType: string;

const keys = fixedSecretKeys(keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }));

// Door codes with a letter no log line's timestamp, duration or hex id can hold: plain digits once
// matched a log line's millisecond timestamp (the final check, "time":1791361381623).
const CODES = ['Q4815', 'Q1623', 'Q4290'];

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  const sink = new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  t = await peopleApp(db, {
    // Reveal is https only (D181).
    publicUrl: 'https://kept.example',
    secretKeys: keys,
    logger: createLogger({ KEPT_LOG_LEVEL: 'trace', KEPT_LOG_FORMAT: 'json' }, sink),
  });
  alfred = await person(t, db, 'alfred');
  bruce = await person(t, db, 'bruce');
  ibrahim = await person(t, db, 'ibrahim');
  familyHome = await createLocation(t, db, alfred, 'complete', 'بيت العائلة');
  garage = await createLocation(t, db, alfred, 'essentials', 'Garage');
  await join(db, familyHome.id, bruce.userId, 'admin');
  doorType = newId();
  await own(
    db,
    `INSERT INTO public.types (id, owner_account_id, name, icon)
     VALUES ($1, $2, 'Door', 'lucide:door-open')`,
    [doorType, familyHome.accountId],
  );
});

beforeEach(() =>
  own(
    db,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  ),
);

/** A new text field of the Door type, and three doors holding values of it. */
async function fieldWith(key: string, values: [Loc, unknown][]) {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.type_fields (id, owner_account_id, type_id, key, label, kind)
     VALUES ($1, $2, $3, $4, $4, 'text')`,
    [id, familyHome.accountId, doorType, key],
  );
  const things: string[] = [];
  for (const [i, [loc, value]] of values.entries()) {
    const thing = newId();
    things.push(thing);
    await own(
      db,
      `INSERT INTO public.things (id, location_id, place_id, name, type_id, custom)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        thing,
        loc.id,
        loc.unplacedId,
        `Door ${key} ${i}`,
        doorType,
        JSON.stringify({ [key]: value }),
      ],
    );
  }
  return { id, things };
}

const versionOf = async (fieldId: string) =>
  (
    await own<{ v: number }>(db, 'SELECT row_version AS v FROM public.type_fields WHERE id = $1', [
      fieldId,
    ])
  )[0]?.v as number;
const preview = (as: Person, fieldId: string, body: object) =>
  call(t, `/api/v1/type-fields/${fieldId}/convert/preview`, { as, body });
const convert = (as: Person, fieldId: string, body: object, version?: number) =>
  call(t, `/api/v1/type-fields/${fieldId}/convert`, {
    as,
    body,
    ...(version !== undefined ? { headers: { 'if-match': String(version) } } : {}),
  });
const customOf = (thingId: string) =>
  own<{ custom: Record<string, unknown>; notes: string | null }>(
    db,
    'SELECT custom, notes FROM public.things WHERE id = $1',
    [thingId],
  ).then((r) => r[0]);
const searchHits = async (q: string) =>
  (
    ok(await call(t, `/api/v1/things?locationId=${familyHome.id}&q=${q}`, { as: alfred }))
      .items as Json[]
  ).length;

describe('POST /api/v1/type-fields/:id/convert/preview', () => {
  it('counts per location, never a value; the owner only', async () => {
    const f = await fieldWith('size_a', [
      [familyHome, '12'],
      [familyHome, 'about 12'],
      [garage, '3,5'],
    ]);
    const p = ok(await preview(alfred, f.id, { kind: 'number', unit: 'cm' }));
    expect(p.total).toBe(3);
    const byId = Object.fromEntries((p.locations as Json[]).map((l) => [l.id, l]));
    expect(byId[familyHome.id]).toMatchObject({
      name: 'بيت العائلة',
      values: 2,
      convertible: 1,
      toNotes: 1,
    });
    expect(byId[garage.id]).toMatchObject({ values: 1, convertible: 1, toNotes: 0 });
    expect(JSON.stringify(p)).not.toContain('about 12');

    expect((await preview(bruce, f.id, { kind: 'number' })).statusCode).toBe(403);
    expect((await preview(ibrahim, f.id, { kind: 'number' })).statusCode).toBe(404);
    const blocked = await preview(alfred, f.id, { kind: 'money' });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json()).toMatchObject({ code: 'field_convert_blocked' });
  });
});

describe('POST /api/v1/type-fields/:id/convert', () => {
  // catalogue: POST /api/v1/type-fields/:id/convert
  it('converts to a number as the preview said; the rest goes to the notes; audited with counts', async () => {
    const f = await fieldWith('size_b', [
      [familyHome, '12'],
      [familyHome, 'about 12'],
      [garage, '3,5'],
    ]);
    const body = { kind: 'number', unit: 'cm' };
    const p = ok(await preview(alfred, f.id, body));
    const res = ok(await convert(alfred, f.id, body, await versionOf(f.id)));
    const shown = p.locations as Json[];
    expect(res).toEqual({
      converted: shown.reduce((n, l) => n + (l.convertible as number), 0),
      toNotes: shown.reduce((n, l) => n + (l.toNotes as number), 0),
    });
    expect(res).toEqual({ converted: 2, toNotes: 1 });
    expect((await customOf(f.things[0] as string))?.custom.size_b).toBe(12);
    expect((await customOf(f.things[2] as string))?.custom.size_b).toBe(3.5);
    expect(await customOf(f.things[1] as string)).toMatchObject({ notes: 'size_b: about 12' });
    const [field] = await own<{ kind: string; unit: string }>(
      db,
      'SELECT kind, unit FROM public.type_fields WHERE id = $1',
      [f.id],
    );
    expect(field).toEqual({ kind: 'number', unit: 'cm' });

    const [event] = await own<{ diff: unknown }>(
      db,
      `SELECT diff FROM public.audit_events WHERE action = 'type.field_convert' AND entity_id = $1`,
      [f.id],
    );
    expect(event?.diff).toMatchObject({
      kind: { before: 'text', after: 'number' },
      converted: { after: 2 },
      to_notes: { after: 1 },
    });
    expect(JSON.stringify(event?.diff)).not.toContain('about 12');
  });

  it('to secret and back: values sealed, gone from custom, search and history; then restored', async () => {
    const f = await fieldWith(
      'door_code',
      CODES.map((c, i) => [i === 2 ? garage : familyHome, c]),
    );
    expect(await searchHits(CODES[0] as string)).toBe(1);
    const p = ok(await preview(alfred, f.id, { toSecret: true }));
    const res = ok(await convert(alfred, f.id, { toSecret: true }, await versionOf(f.id)));
    expect(res).toEqual({ converted: 3, toNotes: 0 });
    expect(p.total).toBe(3);
    expect(JSON.stringify(res)).not.toContain(CODES[0]);
    for (const id of f.things) expect((await customOf(id))?.custom).not.toHaveProperty('door_code');
    expect(await searchHits(CODES[0] as string)).toBe(0);
    const reveal = ok(
      await call(t, `/api/v1/things/${f.things[0]}/secrets/door_code/reveal`, {
        as: alfred,
        method: 'POST',
      }),
    );
    expect(reveal.value).toBe(CODES[0]);
    const events = await own<{ diff: unknown }>(
      db,
      `SELECT diff FROM public.audit_events
        WHERE entity_id = $1 OR (owner_account_id = $2 AND action = 'type.field_convert')`,
      [f.id, familyHome.accountId],
    );
    for (const c of CODES) expect(JSON.stringify(events)).not.toContain(c);

    // Back to plain: every value restored.
    const back = ok(await convert(alfred, f.id, { toSecret: false }, await versionOf(f.id)));
    expect(back).toEqual({ converted: 3, toNotes: 0 });
    for (const [i, id] of f.things.entries()) {
      expect((await customOf(id))?.custom.door_code).toBe(CODES[i]);
    }
    // The test's own searches put a code in their URL; nothing else may.
    const lines = logLines.filter((l) => !l.includes('&q=')).join('\n');
    for (const c of CODES) expect(lines).not.toContain(c);
  });

  it('needs the recovery kit to make a field secret (409 recovery_kit_required)', async () => {
    const f = await fieldWith('alarm_code', [[familyHome, '7777']]);
    await own(
      db,
      `DELETE FROM public.instance_settings WHERE key = 'recovery_kit_acknowledged_at'`,
    );
    const res = await convert(alfred, f.id, { toSecret: true }, await versionOf(f.id));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'recovery_kit_required' });
    expect((await customOf(f.things[0] as string))?.custom.alarm_code).toBe('7777');
  });

  it('is refused on a stale field (412), without If-Match (428), to an admin (403)', async () => {
    const f = await fieldWith('colour_code', [[familyHome, 'red']]);
    const v = await versionOf(f.id);
    expect((await convert(alfred, f.id, { toSecret: true })).statusCode).toBe(428);
    expect((await convert(alfred, f.id, { toSecret: true }, v + 3)).statusCode).toBe(412);
    expect((await convert(bruce, f.id, { toSecret: true }, v)).statusCode).toBe(403);
    expect((await convert(ibrahim, f.id, { toSecret: true }, v)).statusCode).toBe(404);
    expect((await customOf(f.things[0] as string))?.custom.colour_code).toBe('red');
  });
});
