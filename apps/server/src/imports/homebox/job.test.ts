import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../test/app.js';
import { homeboxZip, uploadArchive } from '../../../test/archive-imports.js';
import { type TestDb, testDb } from '../../../test/db.js';
import { type TestFiles, testFiles } from '../../../test/files.js';
import {
  call,
  join,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
} from '../../../test/people.js';
import { createLocation, type Loc, ok, own } from '../../../test/things.js';
import type { Scope } from '../../db/scope.js';
import { runJob } from '../../jobs/boss.js';
import { importArchiveKey } from '../../storage/blob-store.js';
import { homeboxImportJobs, runHomeboxImport } from './job.js';

// T10 (D146, Q11, Q18): the resumable Homebox import job over spike H1's real exports, from the
// upload to the labels. Ibrahim owns Home and Garage; Bruce administers Home, Louis is a member.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
const tenantSent: { name: string; data: object }[] = [];
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let home: Loc;
let garage: Loc;
let homeZip: Buffer;
let familyZip: Buffer;

const log = { info: () => {}, error: () => {} };
const LONG = 240_000;

type Report = {
  summary: Record<string, number>;
  rows: { ref: { id: string }; issues: { code: string }[] }[];
};

const scopeOf = (p: Person): Scope => ({ userId: p.userId, mfa: false });
const jobDeps = () => ({
  pools: db.pools,
  files,
  jobs: {
    send: async () => {},
    sendTenant: async (_c: unknown, name: string, data: object) => {
      tenantSent.push({ name, data });
    },
  },
  log,
});

/** Uploads `zip`, targets `loc`, inspects it, makes the default choices and checks it. */
async function prepare(
  as: Person,
  loc: Loc,
  zip: Buffer,
  over: Record<string, unknown> = {},
): Promise<{ id: string; report: Report }> {
  const id = await uploadArchive(t, as, zip);
  ok(await call(t, `/api/v1/imports/${id}/target`, { as, body: { locationId: loc.id } }));
  ok(await call(t, `/api/v1/imports/${id}/inspect`, { as, body: {} }));
  const run = ok(await call(t, `/api/v1/imports/${id}`, { as }));
  ok(
    await call(t, `/api/v1/imports/${id}/choices`, {
      as,
      headers: { 'if-match': String(run.rowVersion) },
      body: {
        choices: {
          archived: 'skip',
          currency: 'EGP',
          quantityRounding: 'keep_note',
          fields: {},
          types: {},
          insured: 'field',
          seeded: 'skip_unused',
          ...over,
        },
      },
    }),
  );
  const { report } = ok(
    await call(t, `/api/v1/imports/${id}/dry-run`, { as, body: {} }),
  ) as unknown as {
    report: Report;
  };
  return { id, report };
}

const start = async (as: Person, id: string) => {
  const res = await call(t, `/api/v1/imports/${id}/run`, { as, body: {} });
  expect(res.statusCode, res.body).toBe(202);
  return res;
};

const madeBy = async (runId: string) =>
  Object.fromEntries(
    (
      await own<{ entity_type: string; n: number }>(
        db,
        `SELECT entity_type, count(*)::int AS n FROM public.import_source_ids
          WHERE run_id = $1 GROUP BY entity_type`,
        [runId],
      )
    ).map((r) => [r.entity_type, r.n]),
  );
const statusOf = async (runId: string) =>
  (
    await own<{ status: string; error: string | null; progress: number; total: number }>(
      db,
      'SELECT status, error, progress, total FROM public.import_runs WHERE id = $1',
      [runId],
    )
  )[0];
const thingCount = async (loc: Loc) =>
  (
    await own<{ n: number }>(
      db,
      'SELECT count(*)::int AS n FROM public.things WHERE location_id = $1',
      [loc.id],
    )
  )[0]?.n ?? 0;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  home = await createLocation(t, db, ibrahim, 'complete', 'Home');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  homeZip = await homeboxZip('home');
  familyZip = await homeboxZip('family');
}, 120_000);

afterAll(async () => {
  await files?.cleanup();
});

describe('the import-homebox job', () => {
  let runId: string;
  let report: Report;

  it(
    'imports the whole export, matching the dry run, which wrote nothing',
    async () => {
      const before = await thingCount(home);
      ({ id: runId, report } = await prepare(ibrahim, home, homeZip));
      expect(await thingCount(home)).toBe(before);
      await start(ibrahim, runId);
      expect(sent.at(-1)).toEqual({ name: 'import-homebox', data: { runId } });
      const job = homeboxImportJobs({
        pools: db.pools,
        mailer: { send: async () => {} },
        publicUrl: 'https://kept.example',
        log,
        files,
        sendTenant: async (_c, name, data) => {
          tenantSent.push({ name, data });
        },
      }).find((j) => j.name === 'import-homebox');
      if (!job) throw new Error('no import-homebox job');
      await runJob(job, { userId: ibrahim.userId, mfa: false, data: { runId } }, db.pools);

      expect(await statusOf(runId)).toMatchObject({ status: 'done', error: null });
      const s = report.summary;
      expect(await madeBy(runId)).toMatchObject({
        thing: s.things,
        place: s.places,
        purchase: s.purchases,
        warranty: s.warranties,
        service_record: s.services,
        schedule: s.schedules,
        attachment: (s.attachments ?? 0) + (s.links ?? 0),
        type_field: s.fieldsAdded,
      });
      const [codes] = await own<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM public.legacy_codes
          WHERE location_id = $1 AND source = 'homebox'`,
        [home.id],
      );
      expect(codes?.n).toBe(s.legacyCodes);
      // Things say how they came; the archive is gone.
      const [via] = await own<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM public.things t
           JOIN public.import_source_ids s ON s.entity_id = t.id AND s.run_id = $1
          WHERE t.created_via = 'import'`,
        [runId],
      );
      expect(via?.n).toBe(s.things);
      expect(await files.blobs.exists(importArchiveKey(runId))).toBe(false);
      // One import.run event per chunk, with the things as its subjects.
      const [event] = await own<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM public.audit_event_subjects x
           JOIN public.audit_events e ON e.id = x.event_id
          WHERE e.action = 'import.run' AND e.entity_id = $1`,
        [runId],
      );
      expect(event?.n).toBe(s.things);
    },
    LONG,
  );

  it('maps the sale, the lifetime warranty and the photo with its derivatives', async () => {
    const [phone] = await own<{ lifecycle: string }>(
      db,
      `SELECT lifecycle FROM public.things WHERE location_id = $1 AND name = 'Old phone'`,
      [home.id],
    );
    expect(phone).toBeUndefined(); // archived, skipped by the default choice
    const [fridge] = await own<{ lifetime: boolean; starts_on: string }>(
      db,
      `SELECT w.lifetime, w.starts_on::text FROM public.warranties w
         JOIN public.things t ON t.id = w.thing_id
        WHERE t.location_id = $1 AND t.name = 'Fridge'`,
      [home.id],
    );
    expect(fridge).toEqual({ lifetime: true, starts_on: '2023-02-14' });
    const photos = await own<{ has_gps: boolean; variants: number; sort: number }>(
      db,
      `SELECT f.has_gps, (SELECT count(*)::int FROM public.file_derivatives d WHERE d.file_id = f.id)
              AS variants, a.sort
         FROM public.attachments a JOIN public.files f ON f.id = a.file_id
         JOIN public.things t ON t.id = a.thing_id
        WHERE t.location_id = $1 AND t.name = 'Espresso machine' AND a.role = 'photo'
        ORDER BY a.sort`,
      [home.id],
    );
    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({ has_gps: false, sort: 0 });
    expect(photos[0]?.variants).toBeGreaterThan(0);
    // The manual PDF's text is read by the `pdf-text` job it sent.
    expect(tenantSent.some((j) => j.name === 'pdf-text')).toBe(true);
  });

  it(
    'opens a printed Homebox label, and asks which collection when an asset ID repeats',
    async () => {
      const res = ok(
        await call(t, '/api/v1/scan/resolve', {
          as: ibrahim,
          body: { text: 'https://homebox.example/a/000-005' },
        }),
      );
      expect(res).toMatchObject({
        outcome: 'open',
        target: { kind: 'thing', locationId: home.id },
      });

      const family = await prepare(ibrahim, garage, familyZip);
      await start(ibrahim, family.id);
      await runHomeboxImport(jobDeps(), scopeOf(ibrahim), family.id);
      expect(await statusOf(family.id)).toMatchObject({ status: 'done' });
      const both = ok(
        await call(t, '/api/v1/scan/resolve', {
          as: ibrahim,
          body: { text: 'https://homebox.example/a/000-005' },
        }),
      ) as unknown as { outcome: string; candidates: { name: string }[] };
      expect(both.outcome).toBe('legacy_ambiguous');
      expect(both.candidates.map((c) => c.name).sort()).toEqual(['Espresso machine', 'ريموت']);
    },
    LONG,
  );

  it(
    'makes nothing new when the same export is imported again',
    async () => {
      const rows = async () =>
        (
          await own<{ n: number }>(
            db,
            'SELECT count(*)::int AS n FROM public.import_source_ids WHERE location_id = $1',
            [home.id],
          )
        )[0]?.n;
      const before = { things: await thingCount(home), ids: await rows() };
      const again = await prepare(ibrahim, home, homeZip);
      expect(again.report.summary.things).toBe(0);
      await start(ibrahim, again.id);
      await runHomeboxImport(jobDeps(), scopeOf(ibrahim), again.id);
      expect(await statusOf(again.id)).toMatchObject({ status: 'done' });
      expect({ things: await thingCount(home), ids: await rows() }).toEqual(before);
    },
    LONG,
  );
});

describe('both fixtures, counted', () => {
  /** What one import made in its location, and what its dry run left out, by issue code. */
  async function countsOf(loc: Loc, runId: string, report: Report) {
    const one = async (sql: string) => (await own<{ n: number }>(db, sql, [loc.id]))[0]?.n ?? 0;
    const failed = await own<{ failed: unknown }>(
      db,
      `SELECT diff->'failed_steps' AS failed FROM public.audit_events
        WHERE action = 'import.run' AND entity_id = $1 AND diff ? 'failed_steps'`,
      [runId],
    );
    const dropped: Record<string, number> = {};
    for (const row of report.rows) {
      for (const i of row.issues) dropped[i.code] = (dropped[i.code] ?? 0) + 1;
    }
    return {
      things: await one('SELECT count(*)::int AS n FROM public.things WHERE location_id = $1'),
      places: await one(
        'SELECT count(*)::int AS n FROM public.places WHERE location_id = $1 AND NOT is_unplaced',
      ),
      tagsOnThings: await one(
        'SELECT count(*)::int AS n FROM public.thing_tags WHERE location_id = $1',
      ),
      customValues: await one(
        `SELECT coalesce(sum((SELECT count(*) FROM jsonb_object_keys(custom))), 0)::int AS n
           FROM public.things WHERE location_id = $1`,
      ),
      files: await one(
        'SELECT count(*)::int AS n FROM public.attachments WHERE location_id = $1 AND file_id IS NOT NULL',
      ),
      links: await one(
        'SELECT count(*)::int AS n FROM public.attachments WHERE location_id = $1 AND url IS NOT NULL',
      ),
      legacyCodes: await one(
        `SELECT count(*)::int AS n FROM public.legacy_codes WHERE location_id = $1 AND source = 'homebox'`,
      ),
      warranties: await one(
        'SELECT count(*)::int AS n FROM public.warranties WHERE location_id = $1',
      ),
      services: await one(
        'SELECT count(*)::int AS n FROM public.service_records WHERE location_id = $1',
      ),
      schedules: await one(
        'SELECT count(*)::int AS n FROM public.schedules WHERE location_id = $1',
      ),
      purchases: await one(
        'SELECT count(*)::int AS n FROM public.purchases WHERE location_id = $1',
      ),
      sold: await one(
        `SELECT count(*)::int AS n FROM public.things WHERE location_id = $1 AND lifecycle = 'sold'`,
      ),
      failedSteps: failed.flatMap((f) => (Array.isArray(f.failed) ? f.failed : [])),
      dropped,
    };
  }

  /** Into a new location of a new account, so nothing an earlier test made is matched. */
  async function importInto(name: string, zip: Buffer, over: Record<string, unknown> = {}) {
    const owner = await person(t, db, `owner-${name}`);
    const loc = await createLocation(t, db, owner, 'complete', name);
    const { id, report } = await prepare(owner, loc, zip, over);
    await start(owner, id);
    await runHomeboxImport(jobDeps(), scopeOf(owner), id);
    expect(await statusOf(id)).toMatchObject({ status: 'done', error: null });
    return { report, counts: await countsOf(loc, id, report) };
  }

  it(
    'imports Home (homebox-0.26.2-home.zip) with exact counts',
    async () => {
      const { report, counts } = await importInto('home', homeZip, { archived: 'tag' });
      // Nine items (Old phone archived, imported with the tag, ended sold); four places (the
      // seeded eight skipped); 13 entities × (asset ID + UUID).
      expect(counts).toEqual({
        things: 9,
        places: 4,
        tagsOnThings: 6,
        customValues: 6,
        files: 6,
        links: 1,
        legacyCodes: 26,
        warranties: 2,
        services: 1,
        schedules: 1,
        purchases: 3,
        sold: 1,
        failedSteps: [],
        dropped: {
          hb_notifier_skipped: 1,
          hb_seeded_skipped: 14,
          hb_quantity_zero: 7,
          hb_time_default: 2,
          hb_number_integer: 1,
          hb_location_in_item: 1,
          hb_quantity_rounded: 1,
          hb_icon_dropped: 1,
          file_type_refused: 2,
          hb_template_partial: 1,
        },
      });
      expect(report.summary).toMatchObject({ things: 9, places: 4, legacyCodes: 26 });
    },
    LONG,
  );

  it(
    'imports بيت العائلة (homebox-0.26.2-family.zip) with exact counts',
    async () => {
      const { report, counts } = await importInto('family', familyZip);
      expect(counts).toEqual({
        things: 3,
        places: 2,
        tagsOnThings: 1,
        customValues: 0,
        files: 1,
        links: 0,
        legacyCodes: 10,
        warranties: 1,
        services: 1,
        schedules: 0,
        purchases: 1,
        sold: 0,
        failedSteps: [],
        dropped: { hb_seeded_skipped: 14, hb_quantity_zero: 1 },
      });
      expect(report.summary).toMatchObject({ things: 3, places: 2, legacyCodes: 10 });
    },
    LONG,
  );
});

describe('resuming, cancelling and losing the right to import', () => {
  it(
    'resumes a run that stopped after its second chunk, ending with the same counts',
    async () => {
      const loc = await createLocation(t, db, ibrahim, 'complete', 'Resumed');
      const { id, report } = await prepare(ibrahim, loc, homeZip);
      await start(ibrahim, id);
      await runHomeboxImport(
        {
          ...jobDeps(),
          chunk: 5,
          afterChunk: (i) => {
            if (i === 1) throw new Error('the worker died');
          },
        },
        scopeOf(ibrahim),
        id,
      );
      const stopped = await statusOf(id);
      expect(stopped).toMatchObject({ status: 'failed', progress: 10 });
      await start(ibrahim, id);
      await runHomeboxImport({ ...jobDeps(), chunk: 5 }, scopeOf(ibrahim), id);
      expect(await statusOf(id)).toMatchObject({ status: 'done' });
      expect((await madeBy(id)).thing).toBe(report.summary.things);
      expect(await thingCount(loc)).toBe(report.summary.things);
    },
    LONG,
  );

  it(
    'stops at the next chunk when the run is cancelled',
    async () => {
      const loc = await createLocation(t, db, ibrahim, 'complete', 'Cancelled');
      const { id, report } = await prepare(ibrahim, loc, homeZip);
      await start(ibrahim, id);
      await runHomeboxImport(
        {
          ...jobDeps(),
          chunk: 10,
          afterChunk: async (i) => {
            // Cancelled between chunks, as the web's Cancel would.
            if (i === 0)
              ok(await call(t, `/api/v1/imports/${id}/cancel`, { as: ibrahim, body: {} }));
          },
        },
        scopeOf(ibrahim),
        id,
      );
      expect(await statusOf(id)).toMatchObject({ status: 'cancelled', progress: 10 });
      expect((await madeBy(id)).thing ?? 0).toBeLessThan(report.summary.things ?? 0);
      expect(await files.blobs.exists(importArchiveKey(id))).toBe(false);
    },
    LONG,
  );

  it(
    'is a member’s to neither see nor run (404), and stops when its admin is demoted',
    async () => {
      const { id } = await prepare(bruce, home, homeZip, { seeded: 'all' });
      expect((await call(t, `/api/v1/imports/${id}/run`, { as: louis, body: {} })).statusCode).toBe(
        404,
      );
      await start(bruce, id);
      await runHomeboxImport(
        {
          ...jobDeps(),
          chunk: 3,
          afterChunk: async (i) => {
            if (i === 0) {
              await own(
                db,
                `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
                [home.id, bruce.userId],
              );
            }
          },
        },
        scopeOf(bruce),
        id,
      );
      const run = await statusOf(id);
      expect(['cancelled', 'failed']).toContain(run?.status);
      expect(run?.progress).toBeLessThan(run?.total ?? 0);
    },
    LONG,
  );
});
