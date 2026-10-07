import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { fixture, type TestFiles, testFiles, upload } from '../../test/files.js';
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
import { redactUrl } from '../http/logger.js';
import { runJob } from '../jobs/boss.js';
import { reportJobs } from '../reports/jobs.js';
import { exportKey } from '../storage/blob-store.js';
import { incidentJobs } from './jobs.js';

// Step 4, T18 (D158, D169, D180, D201; Q19–Q21): incidents, the insurance report and claim packs,
// through the front door. Reports are rendered for real (Typst in its child process) and read
// back with poppler's pdftotext; claim packs are unzipped here (stored entries, no inflate).
//
// Ibrahim owns Home (Household: money and warranties on) and Garage (Essentials: neither). In
// Home, Bruce is an admin, Louis a member and Talia a viewer (viewers don't see money there).
// Louis is a member of Garage too.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let home: Loc;
let garage: Loc;
let tv: string;
let laptop: string;
let camera: string;
let formula: string;
let receiptSha: string;

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

const logs: { obj: object; msg: string }[] = [];
const log = {
  info: (obj: object, msg: string) => logs.push({ obj, msg }),
  error: (obj: object, msg: string) => logs.push({ obj, msg }),
};
const jobDeps = () => ({
  pools: db.pools,
  mailer: { send: async () => {} },
  publicUrl: 'https://kept.example',
  log,
  files,
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function thing(as: Person, loc: Loc, body: Record<string, unknown>): Promise<string> {
  return ok(
    await call(t, '/api/v1/things', {
      as,
      body: { locationId: loc.id, placeId: loc.unplacedId, ...body },
    }),
    201,
  ).id;
}

/** Undoes an event through the front door. */
const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

const lifecycleOf = async (id: string) =>
  (
    await own<{ lifecycle: string }>(db, 'SELECT lifecycle FROM public.things WHERE id = $1', [id])
  )[0]?.lifecycle;

/** The entries of a ZIP whose entries are stored (not deflated), read from its central directory. */
function unzipStored(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    expect(zip.readUInt16LE(at + 10)).toBe(0);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, zip.subarray(data, data + size));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
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
  await setDisplayName(db, bruce, 'Bruce');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, louis.userId, 'member');

  const lounge = await place(db, home, 'Living room');
  tv = await thing(ibrahim, home, {
    placeId: lounge,
    name: 'Television',
    model: 'QA55Q70D',
    serial: 'SN-TV-0001',
    purchase: { purchasedOn: '2024-03-12', currency: 'EGP', price: '25000' },
  });
  laptop = await thing(ibrahim, home, {
    placeId: lounge,
    name: 'Laptop',
    serial: 'SN-LT-0002',
    purchase: { purchasedOn: '2025-01-05', currency: 'USD', price: '1200' },
  });
  camera = await thing(ibrahim, home, {
    name: 'Camera',
    purchase: { purchasedOn: '2025-06-01', currency: 'EGP', price: '18000' },
  });
  formula = await thing(ibrahim, home, { name: '=HYPERLINK("http://evil")', serial: '+1-2' });

  // A current value for the television, and one after the date the reports are "as of".
  await own(
    db,
    `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                    created_by)
     VALUES ($1, $2, 20000, 'EGP', '2026-06-01', 'appraisal', $3),
            ($1, $2, 99999, 'EGP', '2099-01-01', 'estimate', $3)`,
    [home.id, tv, ibrahim.userId],
  );

  // A photo on the television, and a receipt on the laptop's purchase.
  const photo = await upload(t, ibrahim, home.id, await fixture('photo.jpg'));
  expect(photo.statusCode, photo.body).toBe(201);
  ok(
    await call(t, '/api/v1/attachments', {
      as: ibrahim,
      body: {
        locationId: home.id,
        fileId: photo.json().id,
        subject: { thingId: tv },
        role: 'photo',
      },
    }),
    201,
  );
  const pdf = await fixture('doc.pdf');
  receiptSha = sha(pdf);
  const receipt = await upload(t, ibrahim, home.id, pdf, {
    contentType: 'application/pdf',
    cls: 'evidence',
  });
  expect(receipt.statusCode, receipt.body).toBe(201);
  const [line] = await own<{ purchase_id: string }>(
    db,
    `SELECT pl.purchase_id FROM public.things t
       JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id WHERE t.id = $1`,
    [laptop],
  );
  ok(
    await call(t, '/api/v1/attachments', {
      as: ibrahim,
      body: {
        locationId: home.id,
        fileId: receipt.json().id,
        subject: { purchaseId: line?.purchase_id },
        role: 'receipt',
      },
    }),
    201,
  );
  // A secret on the laptop, which neither the report nor the pack may carry.
  await own(
    db,
    `WITH ty AS (
       INSERT INTO public.types (owner_account_id, parent_id, name, icon)
       VALUES ($1, (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'electronics'),
               'Work laptop', 'lucide:laptop') RETURNING id),
     f AS (
       INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, secret)
       SELECT $1, ty.id, 'bios_pin', 'BIOS PIN', 'text', true FROM ty RETURNING id, type_id),
     u AS (UPDATE public.things SET type_id = (SELECT type_id FROM f) WHERE id = $2)
     INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext,
                                       key_version, updated_by)
     SELECT $3, $2, f.id, 'bios_pin', '{"v": 1, "c": "SECRET-SENTINEL-8Q"}', 1, $4 FROM f`,
    [home.accountId, laptop, home.id, ibrahim.userId],
  );
});

afterAll(async () => {
  await files?.cleanup();
});

// Each case starts with empty rate windows (reports and packs: five an hour per user).
beforeEach(async () => {
  await own(
    db,
    `UPDATE public.report_runs SET created_at = created_at - interval '2 hours'
      WHERE created_at > now() - interval '1 hour'`,
  );
  await own(
    db,
    `UPDATE public.export_runs SET created_at = created_at - interval '2 hours'
      WHERE created_at > now() - interval '1 hour'`,
  );
});

// ---------------------------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------------------------

const createIncident = (as: Person, loc: Loc, body: Record<string, unknown>) =>
  call(t, `/api/v1/locations/${loc.id}/incidents`, { as, body });

describe('incidents', () => {
  // catalogue: POST /api/v1/locations/:id/incidents
  it('records a burglary with its things, ends them stolen, and audits each', async () => {
    const res = await createIncident(ibrahim, home, {
      kind: 'burglary',
      occurredOn: '2026-09-20',
      policeReference: '2026/1182',
      insurerReference: 'CLM-55-0192',
      thingIds: [tv, laptop, camera],
      lifecycle: 'stolen',
    });
    const incident = ok(res, 201) as unknown as {
      id: string;
      thingCount: number;
      things: { id: string; lifecycle: string }[];
      createdBy: { displayName: string };
    };
    expect(incident.thingCount).toBe(3);
    expect(incident.things.map((x) => x.lifecycle)).toEqual(['stolen', 'stolen', 'stolen']);
    expect(incident.createdBy.displayName).toBe('Ibrahim');
    for (const id of [tv, laptop, camera]) expect(await lifecycleOf(id)).toBe('stolen');
    const events = await eventsOf(db, home.id, incident.id);
    expect(events.map((e) => e.action)).toEqual(['incident.create']);
    expect(events[0]?.undoable_until).toBeNull();
    const ended = await eventsOf(db, home.id, tv);
    expect(ended.at(-1)?.action).toBe('thing.lifecycle');
    expect(ended.at(-1)?.diff.lifecycle).toMatchObject({ before: 'in_use', after: 'stolen' });
    // Each thing's end is undoable on its own: the header lists them.
    const ids = String(res.headers['x-kept-audit-event']).split(', ');
    expect(ids).toHaveLength(3);

    // Bring them back into use for the rest of the file.
    for (const id of ids) expect((await undo(ibrahim, id)).statusCode).toBe(200);
    for (const id of [tv, laptop, camera]) expect(await lifecycleOf(id)).toBe('in_use');

    const list = ok(await call(t, `/api/v1/incidents?locationId=${home.id}`, { as: talia }));
    expect((list.items as { id: string }[]).map((i) => i.id)).toContain(incident.id);
    const one = ok(await call(t, `/api/v1/incidents/${incident.id}`, { as: louis }));
    expect(one.policeReference).toBe('2026/1182');
  });

  it('is for owners and admins: members and viewers get 403, a stranger 404', async () => {
    const body = { kind: 'fire', occurredOn: '2026-09-01' };
    expect((await createIncident(louis, home, body)).statusCode).toBe(403);
    expect((await createIncident(talia, home, body)).statusCode).toBe(403);
    ok(await createIncident(bruce, home, body), 201);
    const stranger = await person(t, db, 'murdock');
    expect((await createIncident(stranger, home, body)).statusCode).toBe(404);
  });

  it('is off where Warranties & claims is off (an Essentials location)', async () => {
    const res = await createIncident(ibrahim, garage, { kind: 'loss', occurredOn: '2026-09-01' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'module_off' });
  });

  it('refuses a thing from another location', async () => {
    const drill = await thing(ibrahim, garage, { name: 'Drill' });
    const res = await createIncident(ibrahim, home, {
      kind: 'loss',
      occurredOn: '2026-09-01',
      thingIds: [drill],
    });
    expect(res.statusCode).toBe(400);
  });

  // catalogue: PATCH /api/v1/incidents/:id
  it('PATCH changes the references with If-Match, and undo puts them back', async () => {
    const made = ok(
      await createIncident(ibrahim, home, { kind: 'flood', occurredOn: '2026-08-01' }),
      201,
    );
    const stale = await call(t, `/api/v1/incidents/${made.id}`, {
      as: bruce,
      method: 'PATCH',
      body: { insurerReference: 'X' },
      headers: { 'if-match': '99' },
    });
    expect(stale.statusCode).toBe(412);
    const res = await call(t, `/api/v1/incidents/${made.id}`, {
      as: bruce,
      method: 'PATCH',
      body: { insurerReference: 'INS-7', notes: 'Kitchen pipe' },
      headers: { 'if-match': String(made.rowVersion) },
    });
    const patched = ok(res);
    expect(patched.insurerReference).toBe('INS-7');
    const events = await eventsOf(db, home.id, made.id);
    expect(events.at(-1)?.action).toBe('incident.update');
    expect(events.at(-1)?.diff.insurer_reference).toMatchObject({ before: null, after: 'INS-7' });
    expect((await undo(bruce, String(res.headers['x-kept-audit-event']))).statusCode).toBe(200);
    const back = ok(await call(t, `/api/v1/incidents/${made.id}`, { as: bruce }));
    expect(back.insurerReference).toBeNull();
    expect(back.notes).toBeNull();
  });

  // catalogue: POST /api/v1/incidents/:id/things
  it('adds and removes things, ends the added ones, and undo restores the list', async () => {
    const made = ok(
      await createIncident(ibrahim, home, {
        kind: 'fire',
        occurredOn: '2026-09-10',
        thingIds: [tv],
      }),
      201,
    );
    const res = await call(t, `/api/v1/incidents/${made.id}/things`, {
      as: ibrahim,
      body: { add: [camera], remove: [tv], lifecycle: 'destroyed' },
      headers: { 'if-match': String(made.rowVersion) },
    });
    const changed = ok(res);
    expect((changed.things as { id: string }[]).map((x) => x.id)).toEqual([camera]);
    expect(changed.rowVersion).toBe((made.rowVersion as number) + 1);
    expect(await lifecycleOf(camera)).toBe('destroyed');
    const events = await eventsOf(db, home.id, made.id);
    expect(events.at(-1)?.action).toBe('incident.things');
    expect(events.at(-1)?.diff.thing_ids).toMatchObject({ before: [tv], after: [camera] });
    const ids = String(res.headers['x-kept-audit-event']).split(', ');
    expect(ids).toHaveLength(2);
    for (const id of ids) expect((await undo(ibrahim, id)).statusCode).toBe(200);
    const back = ok(await call(t, `/api/v1/incidents/${made.id}`, { as: ibrahim }));
    expect((back.things as { id: string }[]).map((x) => x.id)).toEqual([tv]);
    expect(await lifecycleOf(camera)).toBe('in_use');
  });

  // catalogue: DELETE /api/v1/incidents/:id
  it('DELETE is a hard delete with the full before-image, and undo brings it back', async () => {
    const made = ok(
      await createIncident(ibrahim, home, {
        kind: 'other',
        occurredOn: '2026-07-07',
        notes: 'Storm',
        thingIds: [tv, camera],
      }),
      201,
    );
    const doc = await upload(t, ibrahim, home.id, await fixture('rotated.jpg'), { id: newId() });
    expect(doc.statusCode, doc.body).toBe(201);
    ok(
      await call(t, '/api/v1/attachments', {
        as: ibrahim,
        body: {
          locationId: home.id,
          fileId: doc.json().id,
          subject: { incidentId: made.id },
          role: 'document',
        },
      }),
      201,
    );
    const res = await call(t, `/api/v1/incidents/${made.id}`, {
      as: ibrahim,
      method: 'DELETE',
      headers: { 'if-match': String(made.rowVersion) },
    });
    expect(res.statusCode).toBe(204);
    expect(await own(db, 'SELECT 1 FROM public.incidents WHERE id = $1', [made.id])).toHaveLength(
      0,
    );
    const events = await eventsOf(db, home.id, made.id);
    const del = events.at(-1);
    expect(del?.action).toBe('incident.delete');
    expect(del?.diff.notes).toMatchObject({ before: 'Storm', after: null });
    expect((del?.diff.documents?.before as unknown[] | undefined)?.length).toBe(1);
    expect((await undo(ibrahim, String(res.headers['x-kept-audit-event']))).statusCode).toBe(200);
    const back = ok(await call(t, `/api/v1/incidents/${made.id}`, { as: ibrahim }));
    expect(back.notes).toBe('Storm');
    expect(back.thingCount).toBe(2);
    expect((back.documents as { subject: unknown }[]).map((d) => d.subject)).toEqual([
      { incidentId: made.id },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The insurance report
// ---------------------------------------------------------------------------------------------

type Run = { id: string; status: string; fileUrl?: string; error?: string };

async function insurance(as: Person, body: object): Promise<{ id: string; pdf: Buffer }> {
  const { id } = ok(await call(t, '/api/v1/reports/insurance', { as, body }), 202);
  const job = reportJobs(jobDeps()).find((j) => j.name === 'report');
  if (!job) throw new Error('no report job');
  await runJob(job, { userId: as.userId, mfa: false, data: { runId: id } }, db.pools);
  const run = ok(await call(t, `/api/v1/reports/${id}`, { as })) as unknown as Run;
  expect(run.status, JSON.stringify(run)).toBe('done');
  const res = await t.app.inject({ method: 'GET', url: run.fileUrl as string });
  expect(res.statusCode).toBe(200);
  expect(String(res.headers['content-disposition'])).toMatch(/filename="kept-insurance-/);
  return { id, pdf: res.rawPayload };
}

describe('the insurance report', () => {
  // catalogue: POST /api/v1/reports/insurance
  it('queues an insurance run, audits report.generate and sends the report job', async () => {
    sent.length = 0;
    const res = await call(t, '/api/v1/reports/insurance', {
      as: louis,
      body: { scope: { locationId: home.id }, asOf: '2026-09-30' },
    });
    const body = ok(res, 202);
    expect(sent).toEqual([{ name: 'report', data: { runId: body.id } }]);
    const [row] = await own<{ kind: string; options: { asOf: string } }>(
      db,
      'SELECT kind, options FROM public.report_runs WHERE id = $1',
      [body.id],
    );
    expect(row).toMatchObject({ kind: 'insurance', options: { asOf: '2026-09-30' } });
    const events = await own<{ action: string; diff: Record<string, { after: unknown }> }>(
      db,
      `SELECT action, diff FROM public.audit_events WHERE entity_type = 'report' AND entity_id = $1`,
      [body.id],
    );
    expect(events.map((e) => e.action)).toEqual(['report.generate']);
    expect(events[0]?.diff.kind?.after).toBe('insurance');
  });

  it.skipIf(!hasPoppler)(
    'lists each thing with its value as of the date, and totals per currency',
    async () => {
      const { pdf } = await insurance(ibrahim, {
        scope: { locationId: home.id },
        asOf: '2026-09-30',
        locale: 'en',
      });
      const text = pdfText(pdf);
      expect(text).toContain('Insurance report');
      expect(text).toContain('As of 30 Sept 2026');
      expect(text).toContain('Owner: Ibrahim');
      expect(text).toMatch(/Living room/);
      expect(text).toContain('SN-TV-0001');
      // The television's value is its 2026 valuation, never the one after the as-of date.
      expect(text).toContain('EGP 20,000.00');
      expect(text).not.toContain('99,999');
      // Totals per currency, of each thing's value or, without one, its purchase price.
      expect(text).toContain('EGP 38,000.00');
      expect(text).toContain('$1,200.00');
      expect(text).not.toContain('SECRET-SENTINEL');
      expect(text).not.toMatch(/In EGP:/);
    },
  );

  it('refuses a report currency without a rate for every pair, naming them (Q21)', async () => {
    const res = await call(t, '/api/v1/reports/insurance', {
      as: ibrahim,
      body: { scope: { locationId: home.id }, asOf: '2026-09-30', reportCurrency: 'EGP' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'rate_missing',
      missing: [{ from: 'USD', to: 'EGP' }],
    });
  });

  it.skipIf(!hasPoppler)('adds a converted total, labelled with the rate date', async () => {
    await own(
      db,
      `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from, created_by)
       VALUES ($1, 'USD', 'EGP', 48.5, '2026-09-01', $2)`,
      [home.accountId, ibrahim.userId],
    );
    const { pdf } = await insurance(ibrahim, {
      scope: { locationId: home.id },
      asOf: '2026-09-30',
      reportCurrency: 'EGP',
      locale: 'en',
    });
    // 38,000 EGP + 1,200 USD × 48.5 = 96,200 EGP.
    expect(pdfText(pdf)).toMatch(/In EGP:\s+EGP 96,200\.00 \(at the rates of 1 Sept 2026\)/);
  });

  it.skipIf(!hasPoppler)('reports an incident: its things, ended, under its header', async () => {
    const made = ok(
      await createIncident(ibrahim, home, {
        kind: 'burglary',
        occurredOn: '2026-09-21',
        policeReference: 'PR-44',
        thingIds: [tv, laptop],
        lifecycle: 'stolen',
      }),
      201,
    );
    try {
      const { pdf } = await insurance(bruce, {
        scope: { incidentId: made.id },
        asOf: '2026-09-30',
        locale: 'en',
      });
      const text = pdfText(pdf);
      expect(text).toContain('Burglary');
      expect(text).toContain('Police reference: PR-44');
      expect(text).toContain('Television');
      expect(text).toContain('Laptop');
      expect(text).toContain('Stolen');
      expect(text).not.toContain('Camera');
    } finally {
      await own(
        db,
        `UPDATE public.things SET lifecycle = 'in_use', ended_on = NULL WHERE id = ANY ($1::uuid[])`,
        [[tv, laptop]],
      );
    }
  });

  it.skipIf(!hasPoppler)('renders in Arabic, shaped, in Eastern digits', async () => {
    const { pdf } = await insurance(ibrahim, {
      scope: { locationId: home.id },
      asOf: '2026-09-30',
      locale: 'ar',
      digits: 'eastern',
    });
    const text = pdfText(pdf);
    // pdftotext splits some ligatures, so whole words are checked where it doesn't.
    for (const s of ['المالك', 'العملة', '٣٨٬٠٠٠٫٠٠', 'SN-TV-0001', 'Television']) {
      expect(text, s).toContain(s);
    }
    expect(text).toContain('Living room');
    expect((text.match(/[؀-ۿ]/g) ?? []).length).toBeGreaterThan(100);
  });

  it('is refused to a viewer who cannot see money, and to a member for an incident', async () => {
    const viewer = await call(t, '/api/v1/reports/insurance', {
      as: talia,
      body: { scope: { locationId: home.id } },
    });
    expect(viewer.statusCode).toBe(403);
    const made = ok(
      await createIncident(ibrahim, home, { kind: 'loss', occurredOn: '2026-09-02' }),
      201,
    );
    const member = await call(t, '/api/v1/reports/insurance', {
      as: louis,
      body: { scope: { incidentId: made.id } },
    });
    expect(member.statusCode).toBe(403);
  });

  it('is off for a member of an Essentials location (no Money module)', async () => {
    const res = await call(t, '/api/v1/reports/insurance', {
      as: louis,
      body: { scope: { locationId: garage.id } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'module_off' });
    const csv = await call(t, `/api/v1/reports/insurance.csv?locationId=${garage.id}`, {
      as: louis,
    });
    expect(csv.statusCode).toBe(404);
    expect(csv.json()).toMatchObject({ code: 'module_off' });
  });

  it('writes the CSV twin: one row per thing, formula-safe, money for who sees it', async () => {
    const res = await call(
      t,
      `/api/v1/reports/insurance.csv?locationId=${home.id}&asOf=2026-09-30`,
      { as: louis },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'id,short_id,name,brand,model,serial,place,lifecycle,quantity,purchased_on,price,price_currency,value,value_currency,valued_on,receipts',
    );
    expect(lines).toHaveLength(5);
    const bad = lines.find((l) => l.startsWith(formula));
    expect(bad).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(bad).toContain(",'+1-2,");
    const tvLine = lines.find((l) => l.startsWith(tv));
    expect(tvLine).toContain('Living room,in_use,1,2024-03-12,25000,EGP,20000,EGP,2026-06-01,0');
    const [event] = await own<{ action: string }>(
      db,
      `SELECT action FROM public.audit_events WHERE location_id = $1 AND actor_id = $2
        ORDER BY at DESC LIMIT 1`,
      [home.id, louis.userId],
    );
    expect(event?.action).toBe('report.export_csv');
    expect(
      (await call(t, `/api/v1/reports/insurance.csv?locationId=${home.id}`, { as: talia }))
        .statusCode,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
// Claim packs
// ---------------------------------------------------------------------------------------------

type Pack = {
  id: string;
  status: string;
  progress: { done: number; total: number };
  bytes?: number;
  link: { expiresAt: string; downloads: number; lastDownloadedAt: string | null } | null;
};

async function buildPack(as: Person, body: object): Promise<string> {
  const { id } = ok(await call(t, '/api/v1/claim-packs', { as, body }), 202);
  const job = incidentJobs(jobDeps()).find((j) => j.name === 'claim-pack');
  if (!job) throw new Error('no claim-pack job');
  const data = sent.findLast((s) => s.name === 'claim-pack')?.data;
  await runJob(job, { userId: as.userId, mfa: false, data }, db.pools);
  return id;
}

const packOf = async (as: Person, id: string) =>
  ok(await call(t, `/api/v1/claim-packs/${id}`, { as })) as unknown as Pack;

const linkFor = async (as: Person, id: string, body: object = {}) =>
  ok(await call(t, `/api/v1/claim-packs/${id}/link`, { as, body })) as unknown as {
    url: string;
    expiresAt: string;
  };

const download = (url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: new URL(url).pathname, headers });

describe('claim packs', () => {
  it('needs the "includes prices and documents" acknowledgement, and an owner or admin', async () => {
    const scope = { locationId: home.id, thingIds: [tv] };
    const bare = await call(t, '/api/v1/claim-packs', { as: ibrahim, body: { scope } });
    expect(bare.statusCode).toBe(400);
    const member = await call(t, '/api/v1/claim-packs', {
      as: louis,
      body: { scope, acknowledged: true },
    });
    expect(member.statusCode).toBe(403);
  });

  // catalogue: POST /api/v1/claim-packs
  it('builds a ZIP of the report, the originals, the photos and serials.csv', async () => {
    sent.length = 0;
    const id = await buildPack(ibrahim, {
      scope: { locationId: home.id, thingIds: [tv, laptop, formula] },
      locale: 'en',
      acknowledged: true,
    });
    const events = await own<{ action: string }>(
      db,
      `SELECT action FROM public.audit_events WHERE entity_type = 'export_run' AND entity_id = $1`,
      [id],
    );
    expect(events.map((e) => e.action)).toEqual(['claim_pack.create']);
    const pack = await packOf(ibrahim, id);
    expect(pack.status, JSON.stringify(pack)).toBe('done');
    expect(pack.progress.done).toBe(pack.progress.total);
    expect(pack.link).toBeNull();
    expect(await files.blobs.exists(exportKey(id))).toBe(true);
    // Only its creator sees it, and the notification says it's ready.
    expect((await call(t, `/api/v1/claim-packs/${id}`, { as: bruce })).statusCode).toBe(404);
    const [notice] = await own<{ kind: string; payload: unknown }>(
      db,
      'SELECT kind, payload FROM public.notifications WHERE user_id = $1',
      [ibrahim.userId],
    );
    expect(notice).toEqual({ kind: 'export_ready', payload: { runId: id, kind: 'claim_pack' } });

    const { url } = await linkFor(ibrahim, id);
    const res = await download(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(String(res.headers['content-disposition'])).toMatch(
      /^attachment; filename="kept-claim-\d{4}-\d{2}-\d{2}\.zip"/,
    );
    expect(Number(res.headers['content-length'])).toBe(pack.bytes);
    const entries = unzipStored(res.rawPayload);
    const names = [...entries.keys()].sort();
    expect(names).toContain('report.pdf');
    expect(names).toContain('serials.csv');
    const receipt = names.find((n) => /^things\/Laptop \(.+\)\/receipt-1\.pdf$/.test(n));
    expect(receipt, names.join('\n')).toBeDefined();
    // The receipt is the original, byte for byte.
    expect(sha(entries.get(receipt as string) as Buffer)).toBe(receiptSha);
    expect(names.some((n) => /^things\/Television \(.+\)\/photo-1\.jpg$/.test(n))).toBe(true);
    // Never a path a person typed: names are cleaned of separators and leading dots.
    expect(names.every((n) => !n.includes('..') && !n.startsWith('/'))).toBe(true);
    const csv = entries.get('serials.csv')?.toString('utf8') ?? '';
    expect(csv).toContain('SN-TV-0001');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(entries.get('report.pdf')?.subarray(0, 5).toString()).toBe('%PDF-');
    for (const bytes of entries.values()) {
      expect(bytes.includes(Buffer.from('SECRET-SENTINEL'))).toBe(false);
    }
  });

  // catalogue: POST /api/v1/claim-packs/:id/link
  it('a link works without a session, counts downloads, and replaces the one before', async () => {
    const id = await buildPack(ibrahim, {
      scope: { locationId: home.id, thingIds: [camera] },
      acknowledged: true,
    });
    const first = await linkFor(ibrahim, id, { days: 2 });
    const days = (Date.parse(first.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThanOrEqual(2);
    expect(first.url).toMatch(new RegExp(`^${t.publicUrl}/x/[A-Za-z0-9_-]{43}$`));
    expect((await download(first.url)).statusCode).toBe(200);
    expect((await download(first.url)).statusCode).toBe(200);
    const pack = await packOf(ibrahim, id);
    expect(pack.link?.downloads).toBe(2);
    expect(pack.link?.lastDownloadedAt).not.toBeNull();
    const events = await own<{ action: string; diff: object }>(
      db,
      `SELECT action, diff FROM public.audit_events
        WHERE entity_type = 'export_run' AND entity_id = $1 ORDER BY at`,
      [id],
    );
    expect(events.map((e) => e.action)).toEqual(['claim_pack.create', 'claim_pack.link']);
    const token = first.url.split('/x/')[1] as string;
    expect(JSON.stringify(events)).not.toContain(token);
    // Only the token's hash is stored, and the request log never shows the token.
    const [row] = await own<{ token_hash: string }>(
      db,
      'SELECT token_hash FROM public.export_runs WHERE id = $1',
      [id],
    );
    expect(row?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(redactUrl(`/x/${token}`)).toBe('/x/[redacted]');

    const second = await linkFor(ibrahim, id);
    expect((await download(first.url)).statusCode).toBe(410);
    expect((await download(second.url)).statusCode).toBe(200);
  });

  // catalogue: DELETE /api/v1/claim-packs/:id/link
  it('is 410 after a revoke, after expiry, and once the creator is no longer an admin', async () => {
    const id = await buildPack(bruce, {
      scope: { locationId: home.id, thingIds: [tv] },
      acknowledged: true,
    });
    const { url } = await linkFor(bruce, id);
    expect((await download(url)).statusCode).toBe(200);
    const revoked = await call(t, `/api/v1/claim-packs/${id}/link`, {
      as: bruce,
      method: 'DELETE',
    });
    expect(revoked.statusCode).toBe(204);
    const events = await own<{ action: string }>(
      db,
      `SELECT action FROM public.audit_events
        WHERE entity_type = 'export_run' AND entity_id = $1 ORDER BY at`,
      [id],
    );
    expect(events.at(-1)?.action).toBe('claim_pack.link_revoke');
    const gone = await download(url, { 'accept-language': 'ar-EG,ar;q=0.9,en;q=0.5' });
    expect(gone.statusCode).toBe(410);
    expect(gone.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(gone.body).toContain('انتهت صلاحية هذا الرابط');
    expect(gone.body).toContain('dir="rtl"');
    expect((await packOf(bruce, id)).link).toBeNull();

    // Expired: the link's own end has passed.
    const again = await linkFor(bruce, id);
    await own(
      db,
      `UPDATE public.export_runs SET token_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    const expired = await download(again.url, { 'accept-language': 'fr' });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain('Ce lien a expiré');

    // The creator demoted to member: the link stops working (D180).
    const third = await linkFor(bruce, id);
    await own(
      db,
      `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
      [home.id, bruce.userId],
    );
    try {
      expect((await download(third.url)).statusCode).toBe(410);
    } finally {
      await own(
        db,
        `UPDATE public.memberships SET role = 'admin' WHERE location_id = $1 AND user_id = $2`,
        [home.id, bruce.userId],
      );
    }
    // An unknown token says the same.
    expect((await download(`${t.publicUrl}/x/${'A'.repeat(43)}`)).statusCode).toBe(410);
  });

  it('packs an incident, with its documents; purge-exports deletes it after 7 days', async () => {
    const made = ok(
      await createIncident(ibrahim, home, {
        kind: 'flood',
        occurredOn: '2026-09-12',
        thingIds: [laptop],
      }),
      201,
    );
    const photo = await upload(t, ibrahim, home.id, await fixture('rotated.jpg'), { id: newId() });
    expect([200, 201]).toContain(photo.statusCode);
    ok(
      await call(t, '/api/v1/attachments', {
        as: ibrahim,
        body: {
          locationId: home.id,
          fileId: photo.json().id,
          subject: { incidentId: made.id },
          role: 'document',
        },
      }),
      201,
    );
    const id = await buildPack(ibrahim, { scope: { incidentId: made.id }, acknowledged: true });
    const { url } = await linkFor(ibrahim, id);
    const names = [...unzipStored((await download(url)).rawPayload).keys()];
    expect(names).toContain('incident/document-1.jpg');
    expect(names.some((n) => n.startsWith('things/Laptop'))).toBe(true);

    await own(
      db,
      `UPDATE public.export_runs SET expires_at = now() - interval '1 minute',
              token_expires_at = now() - interval '2 minutes' WHERE id = $1`,
      [id],
    );
    const purge = incidentJobs(jobDeps()).find((j) => j.name === 'purge-exports');
    if (!purge) throw new Error('no purge-exports job');
    await runJob(purge, {}, db.pools);
    expect(await files.blobs.exists(exportKey(id))).toBe(false);
    expect((await packOf(ibrahim, id)).status).toBe('expired');
    expect((await download(url)).statusCode).toBe(410);
  });
});
