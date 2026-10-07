import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { seedThing, type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { scannedPdf, textPdf } from '../../test/pdf.js';
import { join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, type Loc, own } from '../../test/things.js';
import { createBoss, runJob, type TenantPayload } from '../jobs/boss.js';
import { JOB_POLICIES, queueOptions } from '../jobs/policies.js';
import { bossQueue } from '../jobs/queue.js';
import { backfillPdfText, type PdfBackfillDeps } from './pdf-backfill.js';
import { PDF_TEXT_JOB, pdfTextJobs } from './pdf-text.js';

// `kept admin backfill-pdf-text` (T21 follow-up): PDFs uploaded before the upload queued their
// text. The uploads here go through a recording queue, so, like those older files, they have no
// `file_text` row and no pg-boss job; the backfill sends real jobs through pg-boss.
//
// Ann owns Home and Shed (Shed requires a second factor); Bob was a member of Home and left, one
// of his PDFs attached to a thing and one not; Cai is still a member there.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let boss: PgBoss;
let owner: pg.Pool;
let deps: PdfBackfillDeps;
const sent: RecordedJob[] = [];
let ann: Person;
let bob: Person;
let cai: Person;
let home: Loc;
let shed: Loc;
const ids = {} as Record<'bobs' | 'loose' | 'cais' | 'scan' | 'read' | 'shed' | 'photo', string>;

async function uploadAs(as: Person, loc: Loc, bytes: Buffer, contentType: string) {
  const res = await upload(t, as, loc.id, bytes, { cls: 'document', contentType });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

type JobRow = { id: string; state: string; data: TenantPayload };

async function jobs(): Promise<Map<string, JobRow>> {
  const { rows } = await owner.query<JobRow>(
    `SELECT id, state, data FROM pgboss.job WHERE name = $1 ORDER BY created_on`,
    [PDF_TEXT_JOB],
  );
  return new Map(rows.map((r) => [(r.data.data as { fileId: string }).fileId, r]));
}

const log = { info: () => {}, error: () => {} };

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  cai = await person(t, db, 'cai');
  home = await createLocation(t, db, ann, 'household', 'Home');
  shed = await createLocation(t, db, ann, 'essentials', 'Shed');
  await join(db, home.id, bob.userId, 'member');
  await join(db, home.id, cai.userId, 'member');

  const pdf = 'application/pdf';
  ids.bobs = await uploadAs(bob, home, textPdf([['Kettle manual, Bob']]), pdf);
  ids.loose = await uploadAs(bob, home, textPdf([['Never attached, Bob']]), pdf);
  const kettle = await seedThing(db, home.id, 'Kettle');
  await own(
    db,
    `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
     VALUES ($1, $2, $3, 'invoice', $4)`,
    [home.id, ids.bobs, kettle, bob.userId],
  );
  ids.cais = await uploadAs(cai, home, textPdf([['Oven warranty, Cai']]), pdf);
  ids.scan = await uploadAs(ann, home, scannedPdf(), pdf);
  ids.read = await uploadAs(ann, home, textPdf([['Already read']]), pdf);
  ids.shed = await uploadAs(ann, shed, textPdf([['Mower manual']]), pdf);
  ids.photo = await uploadAs(ann, home, await uniqueJpeg(), 'image/jpeg');
  // Bob leaves after uploading; Shed starts requiring a second factor.
  await own(db, 'DELETE FROM public.memberships WHERE location_id = $1 AND user_id = $2', [
    home.id,
    bob.userId,
  ]);
  await own(db, 'UPDATE public.locations SET require_2fa = true WHERE id = $1', [shed.id]);

  // One PDF already has its text.
  const job = pdfTextJobs({
    pools: db.pools,
    mailer: { send: async () => {} },
    publicUrl: 'https://kept.example',
    log,
    files,
  }).find((j) => j.name === PDF_TEXT_JOB);
  if (!job) throw new Error('no pdf-text job');
  await runJob(job, { userId: ann.userId, mfa: false, data: { fileId: ids.read } }, db.pools);

  boss = createBoss({
    connectionString: db.urls.system,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on('error', (err) => {
    throw err;
  });
  await boss.start();
  await boss.createQueue(PDF_TEXT_JOB, queueOptions(JOB_POLICIES['pdf-text']));
  owner = new pg.Pool({ connectionString: db.urls.owner, max: 2 });
  deps = { owner, app: db.pools.app, queue: bossQueue(boss) };
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await owner?.end();
  await files?.cleanup();
});

describe('backfillPdfText', () => {
  it('the uploads here left no jobs, as uploads before f595aab did', async () => {
    expect(sent.filter((j) => j.name === PDF_TEXT_JOB)).toHaveLength(6);
    expect((await jobs()).size).toBe(0);
  });

  it('a dry run counts the PDFs with no text and queues nothing', async () => {
    const lines: string[] = [];
    const r = await backfillPdfText(deps, { batch: 200, dryRun: true }, (l) => lines.push(l));
    expect(r).toEqual({ found: 5, queued: 0, noWriter: 1, batches: 1 });
    expect(lines[0]).toContain('dry run');
    expect((await jobs()).size).toBe(0);
  });

  it('queues each PDF with no text in batches, as someone who may still write there', async () => {
    const r = await backfillPdfText(deps, { batch: 2 });
    expect(r).toEqual({ found: 5, queued: 4, noWriter: 1, batches: 3 });
    const queued = await jobs();
    expect([...queued.keys()].sort()).toEqual([ids.bobs, ids.cais, ids.scan, ids.shed].sort());
    // The uploader while they may write; Bob left, so the owner for his attached PDF, and no one
    // for the one only he could see.
    expect(queued.get(ids.cais)?.data).toMatchObject({ userId: cai.userId, mfa: false });
    expect(queued.get(ids.bobs)?.data).toMatchObject({ userId: ann.userId, mfa: false });
    expect(queued.get(ids.scan)?.data).toMatchObject({ userId: ann.userId, mfa: false });
    // Shed requires a second factor, which the upload there needed.
    expect(queued.get(ids.shed)?.data).toMatchObject({ userId: ann.userId, mfa: true });
    // Never the photo, nor the PDF already read.
    expect(queued.has(ids.photo)).toBe(false);
    expect(queued.has(ids.loose)).toBe(false);
    expect(queued.has(ids.read)).toBe(false);
  });

  it('queues nothing again while those jobs wait', async () => {
    expect(await backfillPdfText(deps, { batch: 2 })).toEqual({
      found: 1,
      queued: 0,
      noWriter: 1,
      batches: 1,
    });
    expect((await jobs()).size).toBe(4);
  });

  it('the queued jobs read the text; a completed scan is not queued again, a failed job is', async () => {
    const job = pdfTextJobs({
      pools: db.pools,
      mailer: { send: async () => {} },
      publicUrl: 'https://kept.example',
      log,
      files,
    }).find((j) => j.name === PDF_TEXT_JOB);
    if (!job) throw new Error('no pdf-text job');
    const queued = await jobs();
    for (const row of queued.values()) {
      await runJob(job, row.data, db.pools);
      await owner.query(`UPDATE pgboss.job SET state = 'completed' WHERE id = $1`, [row.id]);
    }
    const texts = await own<{ file_id: string }>(
      db,
      'SELECT file_id FROM public.file_text WHERE file_id = ANY($1::uuid[])',
      [[ids.bobs, ids.cais, ids.scan, ids.shed]],
    );
    // The scan has no text layer, so no row.
    expect(texts.map((r) => r.file_id).sort()).toEqual([ids.bobs, ids.cais, ids.shed].sort());

    expect((await backfillPdfText(deps, { batch: 200 })).queued).toBe(0);

    await owner.query(`UPDATE pgboss.job SET state = 'failed' WHERE id = $1`, [
      queued.get(ids.scan)?.id,
    ]);
    expect(await backfillPdfText(deps, { batch: 200 })).toMatchObject({ found: 2, queued: 1 });
  });

  it('refuses a batch outside 1 to 1000', async () => {
    await expect(backfillPdfText(deps, { batch: 0 })).rejects.toThrow(RangeError);
    await expect(backfillPdfText(deps, { batch: 1001 })).rejects.toThrow(RangeError);
  });
});
