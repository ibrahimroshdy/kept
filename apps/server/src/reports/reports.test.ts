import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newId, printedCode } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { fixture, type TestFiles, testFiles, upload } from '../../test/files.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, type Loc, ok, own, place, setDisplayName } from '../../test/things.js';
import { runJob } from '../jobs/boss.js';
import type { Mail } from '../mail/mailer.js';
import { reportKey } from '../storage/blob-store.js';
import { reportJobs } from './jobs.js';
import { runReportSchedules } from './schedules.js';
import { purgeExpiredReports, RATE_LIMIT } from './service.js';

// T32 (D201): the inventory report, end to end through the front door. Each report is rendered
// for real (Typst in its child process) and read back with poppler's pdftotext/pdfinfo.
//
// Ann owns Home and Garage (Household: money on). In Home, Bob is a member and Vic a viewer
// (viewers don't see money there). Nobody but Ann sees the Garage. Eve shares nothing with them.
//
// KEPT_REPORT_OUT=<dir> also writes the English and Arabic PDFs there, for a look by eye.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ann: Person;
let bob: Person;
let vic: Person;
let eve: Person;
let home: Loc;
let garage: Loc;
let tvId: string;
/** As the report prints it: "5KJ‑JZK", the chip's form (D134). */
let tvCode: string;

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
const pdfPages = (pdf: Buffer) =>
  Number(/^Pages:\s+(\d+)/m.exec(execFileSync('pdfinfo', ['-'], { input: pdf }).toString())?.[1]);

const logs: { obj: object; msg: string }[] = [];
const log = {
  info: (obj: object, msg: string) => logs.push({ obj, msg }),
  error: (obj: object, msg: string) => logs.push({ obj, msg }),
};
/** Mails the report job sent (1.3, D228). */
const mailed: Mail[] = [];
const jobDeps = () => ({
  pools: db.pools,
  mailer: { send: async (m: Mail) => void mailed.push(m) },
  publicUrl: 'https://kept.example',
  log,
  files,
});

/** Runs the `report` job for `runId` as `as`, the way a worker would (a tenant job). */
async function work(as: Person, runId: string): Promise<void> {
  const job = reportJobs(jobDeps()).find((j) => j.name === 'report');
  if (!job) throw new Error('no report job');
  await runJob(job, { userId: as.userId, mfa: false, data: { runId } }, db.pools);
}

const request = (as: Person, body: object) => call(t, '/api/v1/reports/inventory', { as, body });

type RunView = {
  id: string;
  status: string;
  progress: { done: number; total: number };
  fileUrl?: string;
  viewUrl?: string;
  bytes?: number;
  error?: string;
  expiresAt: string;
};
const runOf = async (as: Person, id: string) =>
  ok(await call(t, `/api/v1/reports/${id}`, { as })) as unknown as RunView;

/** Requests a report, runs its job, and downloads the PDF through its signed URL. */
async function report(as: Person, body: object): Promise<{ id: string; pdf: Buffer }> {
  const { id } = ok(await request(as, body), 202);
  await work(as, id);
  const run = await runOf(as, id);
  expect(run.status, JSON.stringify(run)).toBe('done');
  expect(run.fileUrl).toMatch(/^\/f\//);
  const res = await t.app.inject({ method: 'GET', url: run.fileUrl as string });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(String(res.headers['content-disposition'])).toMatch(
    /^attachment; filename="kept-inventory-/,
  );
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  const pdf = res.rawPayload;
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(run.bytes).toBe(pdf.length);
  // The same bytes inline, for "Open PDF" (an installed iPhone app can't download), under the
  // same /f/ headers.
  expect(run.viewUrl).toMatch(/^\/f\//);
  expect(run.viewUrl).not.toBe(run.fileUrl);
  const view = await t.app.inject({ method: 'GET', url: run.viewUrl as string });
  expect(view.statusCode).toBe(200);
  expect(view.headers['content-type']).toBe('application/pdf');
  expect(String(view.headers['content-disposition'])).toMatch(
    /^inline; filename="kept-inventory-\d{4}-\d{2}-\d{2}\.pdf"/,
  );
  expect(view.headers['x-content-type-options']).toBe('nosniff');
  expect(view.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(view.rawPayload.equals(pdf)).toBe(true);
  return { id, pdf };
}

async function thing(as: Person, loc: Loc, body: Record<string, unknown>) {
  return ok(
    await call(t, '/api/v1/things', {
      as,
      body: { locationId: loc.id, placeId: loc.unplacedId, ...body },
    }),
    201,
  );
}

async function out(name: string, pdf: Buffer) {
  const dir = process.env.KEPT_REPORT_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), pdf);
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files, mailConfigured: true });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  vic = await person(t, db, 'vic');
  eve = await person(t, db, 'eve');
  await setDisplayName(db, ann, 'Ann Gordon');
  home = await createLocation(t, db, ann, 'household', 'Home');
  garage = await createLocation(t, db, ann, 'household', 'Garage');
  await join(db, home.id, bob.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');

  const kitchen = await place(db, home, 'Kitchen');
  const shelf = await place(db, home, 'Upper shelf', kitchen);
  const matbakh = await place(db, home, 'المطبخ');
  const brand = ok(
    await call(t, `/api/v1/accounts/${home.accountId}/brands`, {
      as: ann,
      body: { name: 'Samsung' },
    }),
    201,
  ) as { id?: string; item?: { id: string } };
  const brandId = brand.item?.id ?? brand.id;

  const tv = await thing(ann, home, {
    placeId: shelf,
    name: 'Television',
    brandId,
    model: 'QA55Q70D',
    serial: 'SN-TV-0001',
    condition: 'good',
    notes: 'NOTES-SENTINEL-7Q',
    purchase: { purchasedOn: '2024-03-12', currency: 'EGP', price: '1250.5' },
  });
  tvId = tv.id;
  tvCode = printedCode((tv as unknown as { shortCode: string }).shortCode);
  await thing(ann, home, {
    placeId: kitchen,
    name: 'Espresso machine',
    condition: 'fair',
    quantity: 2,
    purchase: { purchasedOn: '2025-01-05', currency: 'USD', price: '199.99' },
  });
  await thing(ann, home, {
    placeId: matbakh,
    name: 'غسالة أطباق Bosch',
    purchase: { purchasedOn: '2025-06-01', currency: 'EGP', price: '30000' },
  });
  await thing(ann, garage, {
    name: 'Cordless drill',
    purchase: { purchasedOn: '2025-02-02', currency: 'EGP', price: '4200' },
  });

  // A photo on the television.
  const up = await upload(t, ann, home.id, await fixture('photo.jpg'));
  expect(up.statusCode, up.body).toBe(201);
  ok(
    await call(t, '/api/v1/attachments', {
      as: ann,
      body: {
        locationId: home.id,
        fileId: up.json().id,
        subject: { thingId: tvId },
        role: 'photo',
      },
    }),
    201,
  );

  // A secret on the television (a type with a secret field, and its stored value), which no
  // report may show: the report reads built-in columns only.
  await own(
    db,
    `WITH ty AS (
       INSERT INTO public.types (owner_account_id, parent_id, name, icon)
       VALUES ($1, (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'electronics'),
               'Smart TV', 'lucide:tv') RETURNING id),
     f AS (
       INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, secret)
       SELECT $1, ty.id, 'tv_pin', 'PIN', 'text', true FROM ty RETURNING id, type_id),
     u AS (UPDATE public.things SET type_id = (SELECT type_id FROM f) WHERE id = $2)
     INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext,
                                       key_version, updated_by)
     SELECT $3, $2, f.id, 'tv_pin', '{"v": 1, "c": "SECRET-SENTINEL-4X"}', 1, $4 FROM f`,
    [home.accountId, tvId, home.id, ann.userId],
  );
});

afterAll(async () => {
  await files?.cleanup();
});

// Each case starts with an empty rate window (five runs an hour per user): earlier runs are
// moved back two hours, keeping their 24-hour life.
beforeEach(async () => {
  await own(
    db,
    `UPDATE public.report_runs SET created_at = created_at - interval '2 hours'
      WHERE created_at > now() - interval '1 hour'`,
  );
});

describe('POST /api/v1/reports/inventory', () => {
  // catalogue: POST /api/v1/reports/inventory
  it('queues a run for the location, audits report.generate there, and sends the tenant job', async () => {
    sent.length = 0;
    const res = await request(ann, { scope: { locationId: home.id }, locale: 'en' });
    const body = ok(res, 202) as unknown as { id: string; status: string; expiresAt: string };
    expect(body.status).toBe('queued');
    const hours = (Date.parse(body.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    expect(sent).toEqual([{ name: 'report', data: { runId: body.id } }]);
    const events = await own<{ action: string; actor_id: string; diff: Record<string, unknown> }>(
      db,
      `SELECT action, actor_id, diff FROM public.audit_events
        WHERE entity_type = 'report' AND entity_id = $1`,
      [body.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('report.generate');
    expect(events[0]?.actor_id).toBe(ann.userId);
    const run = await runOf(ann, body.id);
    expect(run).toMatchObject({ status: 'queued', progress: { done: 0, total: 0 } });
    expect(run.fileUrl).toBeUndefined();
    expect(run.viewUrl).toBeUndefined();
  });

  it("audits an account report in each location it covers, and covers only the caller's", async () => {
    const mine = ok(await request(ann, { scope: { accountId: home.accountId } }), 202);
    const annEvents = await own<{ location_id: string }>(
      db,
      `SELECT location_id FROM public.audit_events WHERE entity_type = 'report' AND entity_id = $1`,
      [mine.id],
    );
    // Her Personal location is in her account too.
    expect(annEvents.map((e) => e.location_id).sort()).toEqual(
      [home.id, garage.id, ann.personalLocationId].sort(),
    );
    const bobs = ok(await request(bob, { scope: { accountId: home.accountId } }), 202);
    const [row] = await own<{ location_ids: string[] }>(
      db,
      'SELECT location_ids FROM public.report_runs WHERE id = $1',
      [bobs.id],
    );
    expect(row?.location_ids).toEqual([home.id]);
  });

  it('is a 404 for a location or an account the caller cannot see', async () => {
    expect((await request(eve, { scope: { locationId: home.id } })).statusCode).toBe(404);
    expect((await request(eve, { scope: { accountId: home.accountId } })).statusCode).toBe(404);
    expect((await request(bob, { scope: { locationId: garage.id } })).statusCode).toBe(404);
    expect((await request(eve, { scope: { locationId: newId() } })).statusCode).toBe(404);
  });

  it('refuses a malformed body', async () => {
    expect((await request(ann, { scope: {} })).statusCode).toBe(400);
    expect((await request(ann, { scope: { locationId: home.id }, locale: 'fr' })).statusCode).toBe(
      400,
    );
    expect(
      (await request(ann, { scope: { locationId: home.id, accountId: home.accountId } }))
        .statusCode,
    ).toBe(400);
  });

  it(`allows ${RATE_LIMIT} runs an hour per user, then answers 429 with Retry-After`, async () => {
    const loc = { scope: { locationId: eve.personalLocationId } };
    for (let i = 0; i < RATE_LIMIT; i++) ok(await request(eve, loc), 202);
    const refused = await request(eve, loc);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(3000);
  });
});

describe('the report job and GET /api/v1/reports/:id', () => {
  it('renders an English report with prices, per-currency totals, a photo and QR codes', async () => {
    const started = performance.now();
    const { id, pdf } = await report(ann, {
      scope: { locationId: home.id },
      locale: 'en',
      include: { qr: true },
    });
    const ms = Math.round(performance.now() - started);
    await out('report-en.pdf', pdf);
    const run = await runOf(ann, id);
    expect(run.progress.done).toBe(run.progress.total);
    expect(run.progress.total).toBe(4); // three things, then the render
    const rendered = logs.find(
      (l) => l.msg === 'report rendered' && (l.obj as { runId: string }).runId === id,
    );
    expect(rendered?.obj).toMatchObject({ things: 3 });
    console.info(`report EN: ${ms} ms end to end, ${JSON.stringify(rendered?.obj)}`);
    if (!hasPoppler) return;
    const text = pdfText(pdf);
    for (const s of [
      'Inventory report',
      'Home',
      'Generated by Ann Gordon',
      'Contents',
      'Kitchen › Upper shelf',
      'Television',
      'Samsung QA55Q70D',
      'SN-TV-0001',
      'Smart TV',
      'Good',
      tvCode,
      'EGP 1,250.50',
      '$399.98', // 2 × 199.99
      'EGP 31,250.50', // the EGP total: 1,250.50 + 30,000
      'Totals by currency',
      'kept.example',
    ]) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain('Cordless drill'); // the Garage is another location
    expect(pdfPages(pdf)).toBeGreaterThanOrEqual(3); // cover, contents, things
  });

  it('never prints a secret, notes or anything beyond the built-in columns', async () => {
    const { pdf } = await report(ann, { scope: { locationId: home.id }, locale: 'en' });
    const raw = pdf.toString('latin1');
    expect(raw).not.toContain('SECRET-SENTINEL');
    if (!hasPoppler) return;
    const text = pdfText(pdf);
    expect(text).not.toContain('SECRET-SENTINEL-4X');
    expect(text).not.toContain('NOTES-SENTINEL-7Q');
    expect(text).not.toContain('PIN');
  });

  it("gives a viewer no prices or totals, and a member everything the location's gate shows", async () => {
    const forVic = await report(vic, { scope: { locationId: home.id }, locale: 'en' });
    const forBob = await report(bob, { scope: { locationId: home.id }, locale: 'en' });
    if (!hasPoppler) return;
    const vicText = pdfText(forVic.pdf);
    expect(vicText).toContain('Television');
    for (const money of ['EGP', '$', '1,250', 'Totals by currency', 'Subtotal', 'Bought']) {
      expect(vicText, money).not.toContain(money);
    }
    const bobText = pdfText(forBob.pdf);
    expect(bobText).toContain('EGP 1,250.50');
    expect(bobText).toContain('Totals by currency');
  });

  it('leaves money out for everyone when the Money module is off, and when not asked for', async () => {
    const notAsked = await report(ann, {
      scope: { locationId: home.id },
      locale: 'en',
      include: { money: false },
    });
    await own(
      db,
      `UPDATE public.location_modules SET enabled = false WHERE location_id = $1 AND module = 'money'`,
      [home.id],
    );
    try {
      const off = await report(ann, { scope: { locationId: home.id }, locale: 'en' });
      if (!hasPoppler) return;
      for (const pdf of [off.pdf, notAsked.pdf]) {
        const text = pdfText(pdf);
        expect(text).toContain('Television');
        expect(text).not.toContain('EGP');
        expect(text).not.toContain('Totals by currency');
      }
    } finally {
      await own(
        db,
        `UPDATE public.location_modules SET enabled = true WHERE location_id = $1 AND module = 'money'`,
        [home.id],
      );
    }
  });

  it('covers only the locations the requester can see in an account report', async () => {
    const forAnn = await report(ann, { scope: { accountId: home.accountId }, locale: 'en' });
    const forBob = await report(bob, { scope: { accountId: home.accountId }, locale: 'en' });
    if (!hasPoppler) return;
    const annText = pdfText(forAnn.pdf);
    expect(annText).toContain('All locations');
    expect(annText).toContain('Cordless drill');
    expect(annText).toContain('Garage › Unplaced');
    const bobText = pdfText(forBob.pdf);
    expect(bobText).toContain('Television');
    expect(bobText).not.toContain('Cordless drill');
    expect(bobText).not.toContain('Garage');
  });

  it('renders Arabic right to left, in Eastern digits, with codes kept in Western digits', async () => {
    const started = performance.now();
    const { pdf } = await report(ann, {
      scope: { locationId: home.id },
      locale: 'ar',
      digits: 'eastern',
      include: { qr: true },
    });
    console.info(`report AR: ${Math.round(performance.now() - started)} ms end to end`);
    await out('report-ar.pdf', pdf);
    if (!hasPoppler) return;
    const text = pdfText(pdf);
    // pdftotext splits some ligatures (lam-alef), so whole words are checked where it doesn't.
    for (const s of ['المحتويات', 'المطبخ', tvCode, 'SN-TV-0001', 'Television', '١٬٢٥٠٫٥٠']) {
      expect(text, s).toContain(s);
    }
    expect(text).toContain('غسالة');
    // Paths point right to left: "‹", never "›" (Typst doesn't mirror it).
    expect(text).toContain('‹');
    expect(text).not.toContain('›');
    expect(text).toMatch(/[٠-٩]/);
    expect((text.match(/[؀-ۿ]/g) ?? []).length).toBeGreaterThan(100);
    expect(pdfPages(pdf)).toBeGreaterThanOrEqual(3);
  });

  it('includes ended and trashed things only when asked', async () => {
    const gone = await thing(ann, home, { name: 'Old kettle' });
    await own(
      db,
      `UPDATE public.things SET lifecycle = 'sold', ended_on = '2026-01-01' WHERE id = $1`,
      [gone.id],
    );
    const binned = await thing(ann, home, { name: 'Broken lamp' });
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [binned.id]);
    const plain = await report(ann, { scope: { locationId: home.id }, locale: 'en' });
    const all = await report(ann, {
      scope: { locationId: home.id },
      locale: 'en',
      filters: { includeEnded: true, includeTrashed: true },
    });
    if (!hasPoppler) return;
    const plainText = pdfText(plain.pdf);
    expect(plainText).not.toContain('Old kettle');
    expect(plainText).not.toContain('Broken lamp');
    const allText = pdfText(all.pdf);
    expect(allText).toContain('Old kettle');
    expect(allText).toContain('Sold');
    expect(allText).toContain('Broken lamp');
    expect(allText).toContain('In the trash');
  });

  it("is a 404 for someone else's run, and the file URL is the requester's alone", async () => {
    const { id } = ok(await request(ann, { scope: { locationId: home.id } }), 202);
    expect((await call(t, `/api/v1/reports/${id}`, { as: eve })).statusCode).toBe(404);
    expect((await call(t, `/api/v1/reports/${id}`, { as: bob })).statusCode).toBe(404);
    expect((await call(t, `/api/v1/reports/${newId()}`, { as: ann })).statusCode).toBe(404);
    // Bob running Ann's job id in his own scope finds nothing to do.
    await work(bob, id);
    expect((await runOf(ann, id)).status).toBe('queued');
  });

  it('hides a run once its requester can no longer see the location', async () => {
    const { id } = ok(await request(bob, { scope: { locationId: home.id } }), 202);
    await own(db, 'DELETE FROM public.memberships WHERE location_id = $1 AND user_id = $2', [
      home.id,
      bob.userId,
    ]);
    try {
      expect((await call(t, `/api/v1/reports/${id}`, { as: bob })).statusCode).toBe(404);
    } finally {
      await join(db, home.id, bob.userId, 'member');
    }
  });

  it('expires after 24 hours, and the purge removes the run and its file', async () => {
    const { id } = await report(ann, { scope: { locationId: home.id }, locale: 'en' });
    expect(await files.blobs.exists(reportKey(id))).toBe(true);
    await own(
      db,
      `UPDATE public.report_runs SET created_at = now() - interval '25 hours',
              expires_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
    const expired = await runOf(ann, id);
    expect(expired.status).toBe('expired');
    expect(expired.fileUrl).toBeUndefined();
    expect(expired.viewUrl).toBeUndefined();
    const purged = await purgeExpiredReports({ pools: db.pools, files, log });
    expect(purged.runs).toBeGreaterThanOrEqual(1);
    expect(purged.failedBlobs).toEqual([]);
    expect(await files.blobs.exists(reportKey(id))).toBe(false);
    expect((await call(t, `/api/v1/reports/${id}`, { as: ann })).statusCode).toBe(404);
  });

  it('fails a run with too_many_things past the limit rather than rendering it', async () => {
    const { MAX_THINGS } = await import('./gather.js');
    const { id } = ok(await request(ann, { scope: { locationId: garage.id } }), 202);
    await own(
      db,
      `INSERT INTO public.things (location_id, place_id, name)
       SELECT $1, $2, 'Screw ' || g FROM generate_series(1, $3::int) g`,
      [garage.id, garage.unplacedId, MAX_THINGS],
    );
    try {
      await work(ann, id);
      const run = await runOf(ann, id);
      expect(run).toMatchObject({ status: 'failed', error: 'too_many_things' });
      expect(run.fileUrl).toBeUndefined();
    } finally {
      await own(db, `DELETE FROM public.things WHERE location_id = $1 AND name LIKE 'Screw %'`, [
        garage.id,
      ]);
    }
  });
});

describe('emailed and scheduled reports (D228)', () => {
  const verify = (p: Person) =>
    db.pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE id = $1', [p.userId]);
  const accountAudit = (p: Person) =>
    own(
      db,
      `SELECT e.action FROM public.audit_events e
         JOIN public.owner_accounts oa ON oa.id = e.owner_account_id
        WHERE oa.user_id = $1 AND e.location_id IS NULL ORDER BY e.at, e.id`,
      [p.userId],
    ) as Promise<Array<{ action: string }>>;
  const schedules = (as: Person) => call(t, '/api/v1/me/report-schedules', { as });
  const tenantJobs: Array<{ name: string; data: object }> = [];
  const scanDeps = () => ({
    pools: db.pools,
    log,
    sendTenant: async (_c: unknown, name: string, data: object) =>
      void tenantJobs.push({ name, data }),
  });

  it('mails the PDF to the requester when asked, attached', async () => {
    mailed.length = 0;
    await verify(ann);
    const { id } = ok(await request(ann, { scope: { locationId: home.id }, email: true }), 202);
    await work(ann, id);
    expect((await runOf(ann, id)).status).toBe('done');
    const mail = mailed.find((m) => m.kind === 'report-ready');
    expect(mail).toMatchObject({
      kind: 'report-ready',
      to: ann.email,
      report: 'inventory',
      place: 'Home',
      attached: true,
    });
    const pdf = mail?.attachments?.[0];
    expect(pdf?.contentType).toBe('application/pdf');
    expect(pdf?.filename).toMatch(/^kept-inventory-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(pdf?.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('mails nothing when not asked, or to an unverified address', async () => {
    mailed.length = 0;
    const { id } = ok(await request(bob, { scope: { locationId: home.id }, email: true }), 202);
    await work(bob, id);
    const plain = ok(await request(ann, { scope: { locationId: home.id } }), 202);
    await work(ann, plain.id);
    expect(mailed.filter((m) => m.kind === 'report-ready')).toEqual([]);
  });

  // catalogue: PUT /api/v1/me/report-schedules
  it('keeps one schedule per location and report, audited; a viewer gets no insurance one', async () => {
    const put = (as: Person, body: object) =>
      call(t, '/api/v1/me/report-schedules', { as, method: 'PUT', body });
    const made = ok(await put(ann, { locationId: home.id, kind: 'inventory', cadence: 'weekly' }));
    expect(made).toMatchObject({ locationName: 'Home', kind: 'inventory', cadence: 'weekly' });
    const again = ok(
      await put(ann, { locationId: home.id, kind: 'inventory', cadence: 'monthly' }),
    );
    expect(again).toMatchObject({ id: made.id, cadence: 'monthly' });
    expect(
      (ok(await schedules(ann)) as unknown as { schedules: unknown[] }).schedules,
    ).toHaveLength(1);
    expect(
      (await accountAudit(ann)).map((e) => e.action).filter((a) => a.startsWith('report.')),
    ).toEqual(['report.schedule', 'report.schedule']);
    expect(
      (await put(vic, { locationId: home.id, kind: 'insurance', cadence: 'weekly' })).statusCode,
    ).toBe(403);
    expect(
      (await put(eve, { locationId: home.id, kind: 'inventory', cadence: 'weekly' })).statusCode,
    ).toBe(404);
  });

  // catalogue: DELETE /api/v1/me/report-schedules/:id
  it('removes a schedule, audited; someone else’s is a 404', async () => {
    const made = ok(
      await call(t, '/api/v1/me/report-schedules', {
        as: ann,
        method: 'PUT',
        body: { locationId: home.id, kind: 'inventory', cadence: 'weekly' },
      }),
    );
    const del = (as: Person) =>
      call(t, `/api/v1/me/report-schedules/${made.id}`, { as, method: 'DELETE' });
    expect((await del(bob)).statusCode).toBe(404);
    expect((await del(ann)).statusCode).toBe(204);
    expect((await accountAudit(ann)).map((e) => e.action)).toContain('report.unschedule');
  });

  it('requests a due run as its owner, emailed, once that local day; refusals are kept', async () => {
    tenantJobs.length = 0;
    await call(t, '/api/v1/me/report-schedules', {
      as: ann,
      method: 'PUT',
      body: { locationId: home.id, kind: 'inventory', cadence: 'weekly' },
    });
    const monday = new Date('2026-10-19T12:00:00Z');
    const tuesday = new Date('2026-10-20T12:00:00Z');
    expect(await runReportSchedules(scanDeps(), tuesday)).toEqual({ requested: 0, refused: 0 });
    expect(await runReportSchedules(scanDeps(), monday)).toEqual({ requested: 1, refused: 0 });
    expect(tenantJobs.map((j) => j.name)).toEqual(['report']);
    const [run] = (await own(
      db,
      `SELECT user_id, location_id, email_when_done FROM public.report_runs
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ann.userId],
    )) as Array<{ user_id: string; location_id: string; email_when_done: boolean }>;
    expect(run).toEqual({ user_id: ann.userId, location_id: home.id, email_when_done: true });
    // Once that day.
    expect(await runReportSchedules(scanDeps(), monday)).toEqual({ requested: 0, refused: 0 });

    // The next Monday, past the 5-an-hour limit (the scheduled run is one of them): refused,
    // kept as last_error.
    for (let i = 0; i < RATE_LIMIT - 1; i++)
      ok(await request(ann, { scope: { locationId: home.id } }), 202);
    const next = new Date('2026-10-26T12:00:00Z');
    expect(await runReportSchedules(scanDeps(), next)).toEqual({ requested: 0, refused: 1 });
    const listed = (
      ok(await schedules(ann)) as unknown as { schedules: Array<{ lastError: string | null }> }
    ).schedules[0];
    expect(listed?.lastError).toBe('rate_limited');
  });
});

describe("email Kept can't send is refused (#141)", () => {
  const code = (res: { statusCode: number; json: () => { code?: string } }) => [
    res.statusCode,
    res.json().code,
  ];

  it('refuses email: true and a schedule on a server without mail; a plain report still runs', async () => {
    const bare = await peopleApp(db, { sent: [], files });
    const zed = await person(bare, db, 'zed');
    const at = { locationId: zed.personalLocationId };
    const ask = (body: object) => call(bare, '/api/v1/reports/inventory', { as: zed, body });
    expect(code(await ask({ scope: at, email: true }))).toEqual([409, 'mail_not_configured']);
    expect((await ask({ scope: at })).statusCode).toBe(202);
    const put = await call(bare, '/api/v1/me/report-schedules', {
      as: zed,
      method: 'PUT',
      body: { ...at, kind: 'inventory', cadence: 'weekly' },
    });
    expect(code(put)).toEqual([409, 'mail_not_configured']);
    expect(
      await own(db, 'SELECT id FROM public.report_schedules WHERE user_id = $1', [zed.userId]),
    ).toEqual([]);
    await bare.app.close();
  });

  it('refuses them for an account with no address to send to', async () => {
    const max = await person(t, db, 'max');
    await db.pools.auth.query('UPDATE auth."user" SET email = $2 WHERE id = $1', [
      max.userId,
      `${max.userId}@managed.invalid`,
    ]);
    const at = { locationId: max.personalLocationId };
    const ask = await request(max, { scope: at, email: true });
    expect(code(ask)).toEqual([409, 'no_email_address']);
    const put = await call(t, '/api/v1/me/report-schedules', {
      as: max,
      method: 'PUT',
      body: { ...at, kind: 'inventory', cadence: 'monthly' },
    });
    expect(code(put)).toEqual([409, 'no_email_address']);
  });
});
