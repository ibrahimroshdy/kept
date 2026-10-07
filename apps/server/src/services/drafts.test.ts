import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  eventsOf,
  type Json,
  type Loc,
  ok,
  own,
  setDisplayName,
} from '../../test/things.js';
import { providerKeyAad } from '../ai/db-keys.js';
import { seal } from '../crypto/envelope.js';

// Step 5, T9 through the front door, as the web calls it (apps/web/src/api/vehicles/{types,paths}.ts:
// CreateServiceDraftBody, ConfirmServiceBody, ServiceRecordV5, ServiceRecordsParams): an invoice
// attached first makes a draft service record; with AI capture on, a read of it is queued on the
// same transaction; the draft counts nowhere until confirmed under step 4's create rules; its
// suggestions keep money behind the gate.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person; // owner of Home and Garage
let louis: Person; // member of Home and Garage
let talia: Person; // viewer of Home
let bruce: Person; // admin of Home
let home: Loc; // household: AI capture on, with a provider
let garage: Loc; // AI capture turned off
let carType: string;
let today: string;

const MASTER = { key: Buffer.alloc(32, 9), keyVersion: 1 };

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files, sent });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  bruce = await person(t, db, 'bruce');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, garage.id, louis.userId, 'member');
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled)
     VALUES ($1, 'ai_capture', false)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = false`,
    [garage.id],
  );
  // AI on in Home: its owner account has a provider (sealed as T9 seals it; never called here).
  const providerId = newId();
  await own(
    db,
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                      key_version, models, created_by)
     VALUES ($1, 'account', $2, 'groq', $3, 1, '{"vision": "qwen/qwen3.8-27b"}', $4)`,
    [
      providerId,
      home.accountId,
      JSON.stringify(seal(MASTER, 'gsk_TESTKEY-drafts', providerKeyAad(providerId))),
      ibrahim.userId,
    ],
  );
  carType = await builtinType(db, 'car');
  const [row] = await own<{ today: string }>(
    db,
    `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today`,
  );
  today = row?.today as string;
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

type Car = { id: string; meterId: string };

async function newCar(loc = home, name = 'Corolla'): Promise<Car> {
  const thing = await createThing(t, ibrahim, loc, { name, typeId: carType });
  return { id: thing.id, meterId: ((thing.meters as { id: string }[])[0] as { id: string }).id };
}

async function invoice(as: Person, loc = home): Promise<string> {
  const res = await upload(t, as, loc.id, await uniqueJpeg(), { cls: 'evidence' });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

const draftCall = (as: Person, body: Record<string, unknown>, key: string | null = newId()) =>
  call(t, '/api/v1/service-records/drafts', {
    as,
    body,
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });

async function draft(
  as: Person,
  car: Car,
  loc = home,
): Promise<{ serviceRecord: Json; extraction?: { id: string; status: string } }> {
  const out = ok(
    await draftCall(as, {
      id: newId(),
      subject: { thingId: car.id },
      invoiceFileIds: [await invoice(as, loc)],
    }),
    201,
  );
  return out as unknown as { serviceRecord: Json; extraction?: { id: string; status: string } };
}

const confirm = (as: Person, id: string, version: number, body: Record<string, unknown>) =>
  call(t, `/api/v1/service-records/${id}/confirm`, {
    as,
    body,
    headers: { 'if-match': String(version) },
  });

const get = (as: Person, id: string) => call(t, `/api/v1/service-records/${id}`, { as });

async function reading(car: Car, value: string, daysAgo: number): Promise<void> {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  at.setUTCHours(9, 0, 0, 0);
  ok(
    await call(t, `/api/v1/meters/${car.meterId}/readings`, {
      as: ibrahim,
      body: { value, takenAt: at.toISOString() },
    }),
    201,
  );
}

describe('POST /api/v1/service-records/drafts', () => {
  // catalogue: POST /api/v1/service-records/drafts
  it('with AI capture on, makes a draft with the invoice and queues its read on the same transaction', async () => {
    const car = await newCar();
    sent.length = 0;
    const out = await draft(louis, car);
    const r = out.serviceRecord;
    expect(r).toMatchObject({
      subject: { type: 'thing', id: car.id },
      servicedOn: today,
      reviewState: 'draft',
      flags: [],
      suggestions: [],
      lines: [],
      completes: [],
      total: null,
      reading: null,
      loggedBy: { displayName: 'Louis' },
      extraction: { status: 'queued' },
    });
    expect(r.invoices).toEqual([expect.objectContaining({ role: 'invoice' })]);
    expect(out.extraction?.status).toBe('queued');
    expect(sent).toEqual([{ name: 'extract', data: { extractionId: out.extraction?.id } }]);
    const [ex] = await own<{ mode: string; service_record_id: string; attachment_id: string }>(
      db,
      'SELECT mode, service_record_id, attachment_id FROM public.extractions WHERE id = $1',
      [out.extraction?.id],
    );
    expect(ex).toMatchObject({
      mode: 'receipt',
      service_record_id: r.id,
      attachment_id: (r.invoices as Json[])[0]?.id,
    });
    const events = await eventsOf(db, home.id, r.id);
    expect(events.map((e) => e.action)).toEqual(['service_record.draft']);
    expect(events[0]?.undoable_until).toBeNull();
  });

  it('with AI capture off, a draft has no read and no suggestions', async () => {
    const car = await newCar(garage);
    sent.length = 0;
    const out = await draft(louis, car, garage);
    expect(out.extraction).toBeUndefined();
    expect(out.serviceRecord.extraction).toBeUndefined();
    expect(out.serviceRecord.suggestions).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('needs an Idempotency-Key, and a replay answers the same draft', async () => {
    const car = await newCar();
    const body = {
      id: newId(),
      subject: { thingId: car.id },
      invoiceFileIds: [await invoice(louis)],
    };
    expect((await draftCall(louis, body, null)).statusCode).toBe(400);
    const key = newId();
    const first = ok(await draftCall(louis, body, key), 201);
    const again = await draftCall(louis, body, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first);
  });

  it("refuses a viewer (403), someone else's file (404) and an empty or long invoice list (400), writing nothing", async () => {
    const car = await newCar();
    const theirs = await invoice(louis);
    const id = newId();
    const body = (fileIds: string[]) => ({
      id,
      subject: { thingId: car.id },
      invoiceFileIds: fileIds,
    });
    expect((await draftCall(talia, body([theirs]))).statusCode).toBe(403);
    expect((await draftCall(bruce, body([theirs]))).statusCode).toBe(404);
    expect((await draftCall(louis, body([]))).statusCode).toBe(400);
    expect(
      (await draftCall(louis, body(Array.from({ length: 11 }, () => newId())))).statusCode,
    ).toBe(400);
    const rows = await own(db, 'SELECT 1 FROM public.service_records WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);
    const reads = await own(db, 'SELECT 1 FROM public.extractions WHERE service_record_id = $1', [
      id,
    ]);
    expect(reads).toHaveLength(0);
  });
});

describe('a draft counts nowhere and waits first on the Services tab', () => {
  it('is listed first, filtered by f.draft, and never re-anchors a schedule', async () => {
    const car = await newCar();
    const s = ok(
      await call(t, '/api/v1/schedules', {
        as: ibrahim,
        body: { subject: { thingId: car.id }, name: 'Oil change', everyMonths: 6 },
      }),
      201,
    );
    const logged = ok(
      await call(t, '/api/v1/service-records', {
        as: ibrahim,
        body: {
          subject: { thingId: car.id },
          servicedOn: today,
          lines: [{ kind: 'labour', description: 'Wash' }],
        },
      }),
      201,
    );
    const d = (await draft(louis, car)).serviceRecord;
    const list = ok(await call(t, `/api/v1/things/${car.id}/service-records`, { as: talia }));
    expect((list.items as Json[]).map((x) => [x.id, x.reviewState])).toEqual([
      [d.id, 'draft'],
      [logged.id, 'confirmed'],
    ]);
    const drafts = ok(
      await call(t, `/api/v1/things/${car.id}/service-records?f.draft=1`, { as: ibrahim }),
    );
    expect((drafts.items as Json[]).map((x) => x.id)).toEqual([d.id]);
    const confirmed = ok(
      await call(t, `/api/v1/things/${car.id}/service-records?f.draft=0`, { as: ibrahim }),
    );
    expect((confirmed.items as Json[]).map((x) => x.id)).toEqual([logged.id]);
    const sched = ok(await call(t, `/api/v1/things/${car.id}/schedules`, { as: ibrahim }));
    expect((sched.items as Json[]).find((x) => x.id === s.id)?.lastService).toBeNull();
  });

  it('is not edited (409 service_draft); its logger deletes it with its read, not undoably', async () => {
    const car = await newCar();
    const { serviceRecord: d, extraction } = await draft(louis, car);
    const patch = await call(t, `/api/v1/service-records/${d.id}`, {
      as: louis,
      method: 'PATCH',
      body: { notes: 'x' },
      headers: { 'if-match': String(d.rowVersion) },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().code).toBe('service_draft');
    const del = await call(t, `/api/v1/service-records/${d.id}`, {
      as: louis,
      method: 'DELETE',
      headers: { 'if-match': String(d.rowVersion) },
    });
    expect(del.statusCode).toBe(204);
    expect(del.headers['x-kept-audit-event']).toBeUndefined();
    const reads = await own(db, 'SELECT 1 FROM public.extractions WHERE id = $1', [extraction?.id]);
    expect(reads).toHaveLength(0);
    expect((await get(louis, d.id)).statusCode).toBe(404);
  });
});

describe('the read: suggestions behind the money gate', () => {
  it('shows the succeeded read as suggestions; a viewer gets no amounts', async () => {
    const car = await newCar();
    const { serviceRecord: d, extraction } = await draft(louis, car);
    const attachmentId = (d.invoices as Json[])[0]?.id as string;
    const source = { extractionId: extraction?.id, attachmentId };
    const suggestions = [
      { field: 'vendor', value: { name: 'City Service Centre' }, confidence: 0.92, source },
      { field: 'servicedOn', value: today, confidence: 0.9, source },
      { field: 'total', value: '2250', confidence: 0.94, source },
      { field: 'currency', value: 'EGP', confidence: 0.88, source },
      {
        field: 'line',
        value: { description: 'Engine oil 5W-30', kind: 'fluid', quantity: '4', unitCost: '350' },
        confidence: 0.86,
        source,
      },
    ];
    await own(db, `UPDATE public.extractions SET status = 'succeeded', result = $2 WHERE id = $1`, [
      extraction?.id,
      JSON.stringify({ mode: 'receipt', suggestions, flags: [] }),
    ]);
    const mine = ok(await get(louis, d.id));
    expect(mine.suggestions).toEqual(suggestions);
    expect(mine.extraction).toEqual({ id: extraction?.id, status: 'succeeded' });
    // Home's viewers don't see money (money_visible_to_viewers is off by default, D13).
    const viewer = ok(await get(talia, d.id));
    expect(viewer.suggestions).toEqual([
      suggestions[0],
      suggestions[1],
      {
        ...suggestions[4],
        value: { description: 'Engine oil 5W-30', kind: 'fluid', quantity: '4' },
      },
    ]);
    expect(viewer.invoices).toEqual([]);
  });
});

describe('POST /api/v1/service-records/:id/confirm', () => {
  it('refuses a reading that runs backwards (409 with its neighbour): nothing written, still a draft', async () => {
    const car = await newCar();
    await reading(car, '52000', 3);
    const { serviceRecord: d } = await draft(louis, car);
    const res = await confirm(louis, d.id, d.rowVersion as number, {
      servicedOn: today,
      reading: { meterId: car.meterId, value: '51000' },
      lines: [{ kind: 'part', description: 'Oil filter', unitCost: '450' }],
      currency: 'EGP',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'conflict',
      reason: 'lower_than_previous',
      previous: { value: '52000' },
    });
    const now = ok(await get(louis, d.id));
    expect(now).toMatchObject({ reviewState: 'draft', lines: [], reading: null });
  });

  it('refuses a currency that is not enabled (400)', async () => {
    const car = await newCar();
    const { serviceRecord: d } = await draft(louis, car);
    const res = await confirm(louis, d.id, d.rowVersion as number, {
      servicedOn: today,
      total: '100',
      currency: 'XAU',
    });
    expect(res.statusCode).toBe(400);
    expect(ok(await get(louis, d.id)).reviewState).toBe('draft');
  });

  // catalogue: POST /api/v1/service-records/:id/confirm
  it('logs it under the create rules and completes a schedule; undo makes it a draft again', async () => {
    const car = await newCar();
    await reading(car, '50000', 40);
    const s = ok(
      await call(t, '/api/v1/schedules', {
        as: ibrahim,
        body: {
          subject: { thingId: car.id },
          name: 'Oil change',
          everyUnits: '10000',
          meterId: car.meterId,
          anchorValue: '45000',
        },
      }),
      201,
    );
    const { serviceRecord: d } = await draft(ibrahim, car);
    const res = await confirm(ibrahim, d.id, d.rowVersion as number, {
      servicedOn: today,
      reading: { meterId: car.meterId, value: '52340' },
      vendor: { name: 'City Service Centre' },
      total: '1200',
      currency: 'EGP',
      lines: [
        { kind: 'fluid', description: 'Engine oil 5W-30', quantity: '4', unitCost: '200' },
        { kind: 'labour', description: 'Labour', unitCost: '400' },
      ],
      completes: [s.id],
    });
    const done = ok(res);
    expect(done).toMatchObject({
      reviewState: 'confirmed',
      servicedOn: today,
      reading: { value: '52340', unit: 'km' },
      vendor: { name: 'City Service Centre' },
      total: { amount: '1200', currency: 'EGP' },
      completes: [{ scheduleId: s.id, name: 'Oil change' }],
      flags: [],
    });
    expect(done.suggestions).toBeUndefined();
    const eventId = res.headers['x-kept-audit-event'] as string;
    expect(eventId).toBeTruthy();
    const events = await eventsOf(db, home.id, d.id);
    expect(events.map((e) => e.action)).toEqual(['service_record.draft', 'service_record.confirm']);
    const [anchored] = await own<{ anchor_value: string }>(
      db,
      'SELECT trim_scale(anchor_value)::text AS anchor_value FROM public.schedules WHERE id = $1',
      [s.id],
    );
    expect(anchored?.anchor_value).toBe('52340');

    ok(await call(t, `/api/v1/audit/${eventId}/undo`, { as: ibrahim, body: {} }));
    const back = ok(await get(ibrahim, d.id));
    expect(back).toMatchObject({
      reviewState: 'draft',
      reading: null,
      vendor: null,
      total: null,
      lines: [],
      completes: [],
    });
    const [after] = await own<{ anchor_value: string }>(
      db,
      'SELECT trim_scale(anchor_value)::text AS anchor_value FROM public.schedules WHERE id = $1',
      [s.id],
    );
    expect(after?.anchor_value).toBe('45000');
    const readings = await own(
      db,
      `SELECT 1 FROM public.meter_readings WHERE meter_id = $1 AND trim_scale(value)::text = '52340'`,
      [car.meterId],
    );
    expect(readings).toHaveLength(0);
  });

  it('flags lines that disagree with the total by more than 1%', async () => {
    const car = await newCar();
    const { serviceRecord: d } = await draft(louis, car);
    const done = ok(
      await confirm(louis, d.id, d.rowVersion as number, {
        servicedOn: today,
        total: '1000',
        currency: 'EGP',
        lines: [{ kind: 'part', description: 'Brake pads', quantity: '2', unitCost: '400' }],
      }),
    );
    expect(done.flags).toEqual(['total_mismatch']);
  });

  it('answers 409 for a record that is no draft, and 412 for a stale version', async () => {
    const car = await newCar();
    const { serviceRecord: d } = await draft(louis, car);
    const stale = await confirm(louis, d.id, (d.rowVersion as number) + 5, { servicedOn: today });
    expect(stale.statusCode).toBe(412);
    ok(await confirm(louis, d.id, d.rowVersion as number, { servicedOn: today }));
    const again = await confirm(louis, d.id, (d.rowVersion as number) + 1, { servicedOn: today });
    expect(again.statusCode).toBe(409);
  });
});

describe('GET /api/v1/things/:id/service-records, filtered and sorted', () => {
  it('filters by date, vendor, line kind and words, and sorts by total', async () => {
    const car = await newCar();
    const log = async (servicedOn: string, total: string, kind: string, description: string) =>
      ok(
        await call(t, '/api/v1/service-records', {
          as: ibrahim,
          body: {
            subject: { thingId: car.id },
            servicedOn,
            total,
            currency: 'EGP',
            vendor: { name: `Garage ${description}` },
            lines: [{ kind, description }],
          },
        }),
        201,
      );
    const old = await log('2026-01-10', '300', 'part', 'Wiper blades');
    const mid = await log('2026-06-01', '1500', 'fluid', 'Coolant flush');
    const recent = await log(today, '800', 'labour', 'Alignment');
    const url = (q: string) => `/api/v1/things/${car.id}/service-records?${q}`;
    const ids = async (q: string) =>
      (ok(await call(t, url(q), { as: ibrahim })).items as Json[]).map((x) => x.id);
    expect(await ids('')).toEqual([recent.id, mid.id, old.id]);
    expect(await ids('f.when=2026-01-01..2026-06-30')).toEqual([mid.id, old.id]);
    expect(await ids('f.when=today')).toEqual([recent.id]);
    expect(await ids('f.kind=fluid&f.kind=part')).toEqual([mid.id, old.id]);
    expect(await ids('f.kind=fluid&not=kind')).toEqual([recent.id, old.id]);
    expect(await ids(`f.vendor=${(mid.vendor as Json).id}`)).toEqual([mid.id]);
    expect(await ids('q=coolant')).toEqual([mid.id]);
    expect(await ids('sort=total')).toEqual([mid.id, recent.id, old.id]);
    expect(await ids('sort=total&dir=asc')).toEqual([old.id, recent.id, mid.id]);
    // Pages walk the same order.
    const first = ok(await call(t, url('sort=total&limit=2'), { as: ibrahim }));
    expect((first.items as Json[]).map((x) => x.id)).toEqual([mid.id, recent.id]);
    const second = ok(
      await call(t, url(`sort=total&limit=2&cursor=${first.next_cursor}`), { as: ibrahim }),
    );
    expect((second.items as Json[]).map((x) => x.id)).toEqual([old.id]);
    expect(second.next_cursor).toBeNull();
    expect((await call(t, url('f.when=soon'), { as: ibrahim })).statusCode).toBe(400);
  });
});
