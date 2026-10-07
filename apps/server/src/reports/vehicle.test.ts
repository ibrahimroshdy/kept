import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { COROLLA_SERVICES, corollaShift, logCorollaFills, type Shift } from '../../test/corolla.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Loc,
  ok,
  own,
  setDisplayName,
} from '../../test/things.js';
import { withScope } from '../db/scope.js';
import { runJob } from '../jobs/boss.js';
import { reportJobs } from './jobs.js';
import { gatherVehicle, type VehicleReportOptions } from './vehicle/gather.js';

// Step-5 T15 (D51, D201; Q16): the vehicle history report, end to end through the front door and
// the `report` job, rendered for real (Typst in its child process) and read back with poppler.
//
// Ibrahim owns the Garage (Complete); Alfred is a member and logs the Corolla's fills, Bruce an
// admin, Talia a viewer (viewers don't see money there). Peter has a location of his own.
// KEPT_REPORT_OUT=<dir> also writes the PDFs there, for a look by eye.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let alfred: Person;
let bruce: Person;
let talia: Person;
let peter: Person;
let garage: Loc;
let shift: Shift;
let corolla: { id: string; meterId: string };
const VIN = 'JTDBR32E720123456';
const PLATE = 'س ع ط ٧٤٥١';

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

async function work(as: Person, runId: string): Promise<void> {
  const job = reportJobs({
    pools: db.pools,
    mailer: { send: async () => {} },
    publicUrl: 'https://kept.example',
    log,
    files,
  } as never).find((j) => j.name === 'report');
  if (!job) throw new Error('no report job');
  await runJob(job, { userId: as.userId, mfa: false, data: { runId } }, db.pools);
}

const request = (as: Person, body: object) =>
  call(t, '/api/v1/reports/vehicle-history', { as, body });

/** Requests the report, runs its job, and downloads the PDF. */
async function report(as: Person, body: object, name: string): Promise<string> {
  const { id } = ok(await request(as, body), 202);
  await work(as, id);
  const run = ok(await call(t, `/api/v1/reports/${id}`, { as }));
  expect(run.status, JSON.stringify(run)).toBe('done');
  const res = await t.app.inject({ method: 'GET', url: run.fileUrl as string });
  expect(res.statusCode).toBe(200);
  expect(String(res.headers['content-disposition'])).toMatch(
    /^attachment; filename="kept-vehicle-history-\d{4}-\d{2}-\d{2}\.pdf"/,
  );
  const pdf = res.rawPayload;
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const dir = process.env.KEPT_REPORT_OUT;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), pdf);
  }
  return hasPoppler ? pdfText(pdf) : '';
}

async function photo(as: Person): Promise<string> {
  const up = await upload(t, as, garage.id, await uniqueJpeg());
  expect(up.statusCode, up.body).toBe(201);
  return up.json().id;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files });
  ibrahim = await person(t, db, 'ibrahim');
  alfred = await person(t, db, 'alfred');
  bruce = await person(t, db, 'bruce');
  talia = await person(t, db, 'talia');
  peter = await person(t, db, 'peter');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, alfred, 'Alfred');
  await setDisplayName(db, bruce, 'Bruce');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await createLocation(t, db, peter, 'complete', 'Peter’s');
  await join(db, garage.id, alfred.userId, 'member');
  await join(db, garage.id, bruce.userId, 'admin');
  await join(db, garage.id, talia.userId, 'viewer');
  shift = await corollaShift(db);

  const thing = await createThing(t, ibrahim, garage, {
    name: 'Toyota Corolla',
    typeId: await builtinType(db, 'car'),
    custom: { vin: VIN, plate: PLATE },
  });
  corolla = { id: thing.id, meterId: (thing.meters as { id: string }[])[0]?.id as string };
  await logCorollaFills(t, alfred, corolla.id, shift, { vendor: { name: 'Ring Road Station' } });

  // Two services, the oil change with its invoice photo.
  const [oil, brakes] = COROLLA_SERVICES;
  const serviceIds: string[] = [];
  for (const [s, by, lines] of [
    [
      oil,
      alfred,
      [{ kind: 'fluid', description: 'Engine oil 5W-30', quantity: '4', unitCost: '350' }],
    ],
    [brakes, bruce, [{ kind: 'part', description: 'Front brake pads', unitCost: '3200' }]],
  ] as const) {
    if (!s) continue;
    const made = ok(
      await call(t, '/api/v1/service-records', {
        as: by,
        body: {
          subject: { thingId: corolla.id },
          servicedOn: shift.day(s[0]),
          reading: { meterId: corolla.meterId, value: s[1] },
          total: s[2],
          currency: 'EGP',
          vendor: { name: 'Bay Motors' },
          lines,
        },
      }),
      201,
    );
    serviceIds.push(made.id as string);
  }
  ok(
    await call(t, '/api/v1/attachments', {
      as: alfred,
      body: {
        locationId: garage.id,
        fileId: await photo(alfred),
        subject: { serviceRecordId: serviceIds[0] },
        role: 'invoice',
      },
    }),
    201,
  );

  // A reading typed with its proof photo, today.
  ok(
    await call(t, `/api/v1/meters/${corolla.meterId}/readings`, {
      as: alfred,
      body: {
        value: '52600',
        takenAt: new Date().toISOString(),
        proofFileId: await photo(alfred),
      },
    }),
    201,
  );
  ok(
    await call(t, '/api/v1/documents', {
      as: alfred,
      body: {
        subject: { thingId: corolla.id },
        kind: 'insurance',
        expiresOn: shift.day('2027-05-14'),
        issuedOn: shift.day('2026-05-15'),
        cost: '3500',
        currency: 'EGP',
      },
    }),
    201,
  );
});

afterAll(async () => {
  await t.app.close();
});

describe('POST /api/v1/reports/vehicle-history (T15)', () => {
  it('bounds the odometer rows: photos, typed readings and the latest of each month', async () => {
    const options: VehicleReportOptions = {
      kind: 'vehicle_history',
      thingId: corolla.id,
      from: null,
      to: null,
      include: { costs: true, proofPhotos: true, fuel: true, documents: true },
      locale: 'en',
      digits: 'western',
    };
    const g = await withScope(db.pools.app, { userId: ibrahim.userId, mfa: false }, (tx, c) =>
      gatherVehicle(tx, c, { userId: ibrahim.userId, mfa: false }, options),
    );
    // 22 fills + 2 services + 1 typed reading.
    expect(g.readingCount).toBe(25);
    expect(g.readings.length).toBeLessThan(g.readingCount);
    expect(g.readings.at(-1)).toMatchObject({ value: '52600', source: 'photo', by: 'Alfred' });
    const months = new Set(g.readings.map((r) => r.day.slice(0, 7)));
    expect(g.readings.length).toBe(months.size);
    expect(g.proofs).toHaveLength(1);
    expect(g.services.map((s) => s.money?.total)).toEqual(['2250', '4194.5']);
    expect(g.services[0]?.invoices).toHaveLength(1);
    expect(g.fuel?.years.reduce((n, y) => n + y.fills, 0)).toBe(22);
    expect(g.documents).toEqual([expect.objectContaining({ kind: 'insurance', renewed: false })]);
  });

  // catalogue: POST /api/v1/reports/vehicle-history
  it('renders the Corolla in English and Arabic, audited as report.generate with its kind', async () => {
    const en = await report(ibrahim, { thingId: corolla.id, locale: 'en' }, 'vehicle-en.pdf');
    const ar = await report(
      ibrahim,
      { thingId: corolla.id, locale: 'ar', digits: 'eastern' },
      'vehicle-ar.pdf',
    );
    const events = await own<{ kind: string; thing: string }>(
      db,
      `SELECT diff->'kind'->>'after' AS kind, diff->'thing_id'->>'after' AS thing
         FROM public.audit_events
        WHERE location_id = $1 AND action = 'report.generate' ORDER BY at, id`,
      [garage.id],
    );
    expect(events.map((e) => [e.kind, e.thing])).toEqual([
      ['vehicle_history', corolla.id],
      ['vehicle_history', corolla.id],
    ]);
    if (!hasPoppler) return;
    for (const part of [
      'Vehicle history',
      'Toyota Corolla',
      'Odometer history',
      'Services',
      'Fuel',
      'Documents',
      'Engine oil 5W-30',
      'Bay Motors',
      'EGP 2,250.00',
      '52,600 km',
    ]) {
      expect(en, part).toContain(part);
    }
    // The VIN stays one left-to-right word in both; the Arabic plate's letters are all there.
    expect(en).toContain(VIN);
    expect(ar).toContain(VIN);
    expect(ar).toContain('سجل المركبة');
    for (const ch of ['س', 'ع', 'ط']) expect(ar).toContain(ch);
    expect(ar).toContain('٥٢٬٦٠٠');
  });

  it('gives a viewer no amounts, and refuses a vehicle elsewhere and Vehicles off', async () => {
    const text = await report(talia, { thingId: corolla.id, locale: 'en' }, 'vehicle-viewer.pdf');
    if (hasPoppler) {
      expect(text).toContain('Toyota Corolla');
      expect(text).not.toContain('EGP');
      expect(text).toContain('Costs are left out');
    }
    expect((await request(peter, { thingId: corolla.id })).statusCode).toBe(404);
    expect((await request(peter, { thingId: newId() })).statusCode).toBe(404);
    await own(
      db,
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'vehicles', false)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [garage.id],
    );
    const off = await request(ibrahim, { thingId: corolla.id });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: 'module_off' });
    await own(
      db,
      `DELETE FROM public.location_modules WHERE location_id = $1 AND module = 'vehicles'`,
      [garage.id],
    );
  });
});
