import { CSV_BOM, newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles } from '../../test/files.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, createThing, type Json, type Loc, ok, own } from '../../test/things.js';
import { withScope } from '../db/scope.js';
import { gather } from '../reports/gather.js';

// Step-7 T16 (D169): the things list as a CSV, the import filter, and the report's `thingIds`.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person; // owns Home (complete: money on) and Garage (essentials: no money module)
let bruce: Person; // admin of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home and of Garage
let alfred: Person; // owns بيت العائلة, nothing of Ibrahim's
let home: Loc;
let garage: Loc;
let family: Loc;
let drill: Json;
let formula: Json;
let runId: string;
let alfredsRun: string;

/** The CSV's rows as cells (a small parser: quoted cells may hold commas, quotes and breaks). */
function parse(body: string): string[][] {
  expect(body.startsWith(CSV_BOM)).toBe(true);
  const text = body.slice(CSV_BOM.length);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  expect(cell).toBe('');
  return rows;
}

const csv = (as: Person, query: string): Promise<LightMyRequestResponse> =>
  call(t, `/api/v1/things.csv?${query}`, { as });

async function importRun(loc: Loc, by: Person, thingIds: string[]): Promise<string> {
  const [run] = await own<{ id: string }>(
    db,
    `INSERT INTO public.import_runs (location_id, source, status, created_by)
     VALUES ($1, 'csv', 'done', $2) RETURNING id`,
    [loc.id, by.userId],
  );
  const id = run?.id as string;
  for (const [i, thingId] of thingIds.entries()) {
    await own(
      db,
      `INSERT INTO public.import_source_ids
         (location_id, source, source_id, entity_type, entity_id, run_id)
       VALUES ($1, 'csv', $2, 'thing', $3, $4)`,
      [loc.id, `${id}:${i}`, thingId, id],
    );
  }
  return id;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent: [], files });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'complete', 'Home');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  family = await createLocation(t, db, alfred, 'complete', 'بيت العائلة');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, talia.userId, 'viewer');

  drill = await createThing(t, ibrahim, home, {
    name: 'Drill',
    serial: 'SN-1',
    purchase: { purchasedOn: '2026-09-01', currency: 'EGP', price: '1250.50' },
  });
  formula = await createThing(t, ibrahim, home, { name: '=HYPERLINK("x")', serial: '-1+1' });
  await createThing(t, ibrahim, garage, { name: 'مثقاب، كبير "جديد"' });
  const cousins = await createThing(t, alfred, family, { name: 'Kettle' });
  runId = await importRun(home, ibrahim, [drill.id, formula.id]);
  alfredsRun = await importRun(family, alfred, [cousins.id]);
});

afterAll(async () => {
  await files?.cleanup();
});

describe('GET /api/v1/things.csv', () => {
  it('writes the list’s rows in its order, formula-safe, with a BOM and CRLF, and audits it', async () => {
    const q = `locationId=${home.id}&locationId=${garage.id}&sort=name`;
    const res = await csv(ibrahim, q);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="kept-things-/);
    const [header, ...rows] = parse(res.body);
    expect(header).toEqual([
      'short_id',
      'name',
      'place',
      'type',
      'brand',
      'model',
      'serial',
      'quantity',
      'condition',
      'tags',
      'lifecycle',
      'last_seen',
      'own_codes',
      'purchase_date',
      'price',
      'currency',
    ]);
    // The list's own rows and order.
    const list = ok(await call(t, `/api/v1/things?${q}&limit=100`, { as: ibrahim }));
    const names = (list.items as { name: string }[]).map((r) => r.name);
    expect(rows.map((r) => r[1]?.replace(/^'/, ''))).toEqual(names);
    // Formula triggers defused (D169; the tab and carriage return in @kept/shared's tests); Arabic, a comma and quotes intact.
    const byName = new Map(rows.map((r) => [r[1], r]));
    expect(byName.get(`'=HYPERLINK("x")`)?.[6]).toBe(`'-1+1`);
    expect(byName.has('مثقاب، كبير "جديد"')).toBe(true);
    // Money where the gate shows it (Home), blank where the module is off (Garage).
    const drillRow = byName.get('Drill') as string[];
    expect(drillRow.slice(13)).toEqual(['2026-09-01', '1250.5', 'EGP']);
    expect(drillRow[2]).toBe('Unplaced');
    expect(byName.get('مثقاب، كبير "جديد"')?.slice(13)).toEqual(['', '', '']);
    // Audited per location, with the filter and the rows it drew from there.
    const events = (await auditOf(db, home.id)).filter((e) => e.action === 'things.export_csv');
    expect(events.at(-1)).toMatchObject({ actor_id: ibrahim.userId });
    expect(JSON.stringify(events.at(-1)?.diff)).toContain('"rows"');
    const garageEvents = (await auditOf(db, garage.id)).filter(
      (e) => e.action === 'things.export_csv',
    );
    expect(garageEvents).toHaveLength(1);
  });

  it('has no money columns for a viewer who may not see money, nor in an Essentials location', async () => {
    const viewer = parse((await csv(talia, `locationId=${home.id}`)).body);
    expect(viewer[0]).not.toContain('price');
    expect(viewer.flat().join()).not.toContain('1250');
    const essentials = parse((await csv(ibrahim, `locationId=${garage.id}`)).body);
    expect(essentials[0]).not.toContain('price');
  });

  it('filters like the list: a filtered CSV equals the filtered list, and 404 for a location it can’t see', async () => {
    const q = `locationId=${home.id}&q=Drill`;
    const rows = parse((await csv(louis, q)).body).slice(1);
    const list = ok(await call(t, `/api/v1/things?${q}`, { as: louis }));
    expect(rows.map((r) => r[1])).toEqual((list.items as { name: string }[]).map((r) => r.name));
    expect(rows).toHaveLength(1);
    expect((await csv(alfred, `locationId=${home.id}`)).statusCode).toBe(404);
  });

  it('allows five an hour per person, then 429 with retryAfter', async () => {
    for (let i = 0; i < 5; i++)
      expect((await csv(bruce, `locationId=${home.id}`)).statusCode).toBe(200);
    const sixth = await csv(bruce, `locationId=${home.id}`);
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('importRunId', () => {
  it('lists only the things that run brought in', async () => {
    const page = ok(await call(t, `/api/v1/things?importRunId=${runId}`, { as: ibrahim }));
    expect((page.items as Json[]).map((r) => r.id).sort()).toEqual([drill.id, formula.id].sort());
    const rows = parse((await csv(ibrahim, `importRunId=${runId}`)).body).slice(1);
    expect(rows).toHaveLength(2);
  });

  it('matches nothing for another household’s run, an unknown run, or a member', async () => {
    for (const [as, id] of [
      [ibrahim, alfredsRun],
      [ibrahim, newId()],
      [louis, runId],
    ] as const) {
      const page = ok(await call(t, `/api/v1/things?importRunId=${id}`, { as }));
      expect(page.items).toEqual([]);
    }
  });
});

describe('POST /api/v1/reports/inventory with thingIds', () => {
  it('takes thingIds up to the report’s limit', async () => {
    const res = await call(t, '/api/v1/reports/inventory', {
      as: ibrahim,
      body: { scope: { locationId: home.id }, filters: { thingIds: [drill.id] } },
    });
    expect(res.statusCode, res.body).toBe(202);
    const [run] = await own<{ options: { filters: { thingIds: string[] } } }>(
      db,
      'SELECT options FROM public.report_runs WHERE id = $1',
      [(res.json() as { id: string }).id],
    );
    expect(run?.options.filters.thingIds).toEqual([drill.id]);
    const tooMany = await call(t, '/api/v1/reports/inventory', {
      as: ibrahim,
      body: {
        scope: { locationId: home.id },
        filters: { thingIds: Array.from({ length: 2001 }, () => newId()) },
      },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('prints exactly those things', async () => {
    const scope = { userId: ibrahim.userId, mfa: false };
    const got = await withScope(db.pools.app, scope, (tx, client) =>
      gather(tx, client, scope, {
        locationIds: [home.id],
        scope: { locationId: home.id },
        options: {
          filters: {
            placeIds: [],
            typeIds: [],
            tagIds: [],
            thingIds: [drill.id],
            includeEnded: false,
            includeTrashed: false,
          },
          include: { photos: false, qr: false, money: true },
          locale: 'en',
          digits: 'western',
        },
      }),
    );
    expect(got.things.map((x) => x.id)).toEqual([drill.id]);
  });
});
