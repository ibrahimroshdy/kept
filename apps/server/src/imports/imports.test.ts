import { IMPORT_ISSUE_CODES, newId } from '@kept/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  auditOf,
  call,
  join,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
} from '../../test/people.js';
import { createLocation, type Loc, ok, own } from '../../test/things.js';
import { withScope } from '../db/scope.js';
import { runJob } from '../jobs/boss.js';
import { CHUNK, importChunk, importJobs } from './job.js';

// T18 (D73, Q18): CSV import through the front door. Ann owns Home (household: money on) and
// Shed (essentials: money off); in Home, Bob is an admin and Louis a member. Eve shares nothing.
// The job is run the way a worker runs it: a tenant job in the sender's scope (runJob).

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
let ann: Person;
let bob: Person;
let louis: Person;
let eve: Person;
let home: Loc;
let shed: Loc;

const log = { info: () => {}, error: () => {} };
/** The cases that work a whole chunk (CHUNK rows through the services): seconds on an idle
 * machine, much more beside other test runs. */
const LONG = 180_000;
const jobDeps = () => ({
  pools: db.pools,
  mailer: { send: async () => {} },
  publicUrl: 'https://kept.example',
  log,
});

type Run = {
  id: string;
  status: string;
  progress: number;
  total: number | null;
  error: string | null;
  report?: Report;
};
type Report = {
  summary: Record<string, number>;
  rows: {
    row: number;
    status: string;
    issues: { column: string; code: string; params?: object; message: string }[];
  }[];
};

const choices = (over: Record<string, unknown> = {}) => ({
  placeSeparator: '>',
  createPlaces: true,
  dateFormat: 'DD/MM/YYYY',
  defaultTarget: { unplaced: true },
  typeByName: true,
  ...over,
});

const MAPPING = {
  Name: 'name',
  Place: 'place_path',
  Qty: 'quantity',
  Bought: 'purchased_on',
  Price: 'price',
  Shop: 'vendor',
  Notes: 'notes',
  Code: 'legacy_code',
  Brand: 'brand',
  Tags: 'tags',
  Type: 'type',
} as const;
const COLUMNS = Object.keys(MAPPING);

/** A row in COLUMNS' order, from the cells given. */
const row = (cells: Partial<Record<keyof typeof MAPPING, string>>) =>
  COLUMNS.map((c) => cells[c as keyof typeof MAPPING] ?? '');

function create(
  as: Person,
  loc: Loc,
  rows: string[][],
  extra: { columns?: string[]; mapping?: Record<string, string>; choices?: object } = {},
) {
  return call(t, '/api/v1/imports/csv', {
    as,
    body: {
      locationId: loc.id,
      columns: extra.columns ?? COLUMNS,
      rows,
      mapping: extra.mapping ?? MAPPING,
      choices: extra.choices ?? choices(),
    },
  });
}

const dryRun = (as: Person, id: string) =>
  call(t, `/api/v1/imports/${id}/dry-run`, { as, body: {} });
const start = (as: Person, id: string) => call(t, `/api/v1/imports/${id}/run`, { as, body: {} });
const cancel = (as: Person, id: string) =>
  call(t, `/api/v1/imports/${id}/cancel`, { as, body: {} });
const runOf = async (as: Person, id: string) =>
  ok(await call(t, `/api/v1/imports/${id}`, { as })) as unknown as Run;

/** Runs the queued `import-csv` job for `runId` as `as`, as a worker would. */
async function work(as: Person, runId: string): Promise<void> {
  const job = importJobs(jobDeps()).find((j) => j.name === 'import-csv');
  if (!job) throw new Error('no import-csv job');
  await runJob(job, { userId: as.userId, mfa: false, data: { runId } }, db.pools);
}

/** Creates, dry-runs, starts and works an import; answers the run and its report. */
async function importRows(
  as: Person,
  loc: Loc,
  rows: string[][],
  extra: Parameters<typeof create>[3] = {},
): Promise<{ run: Run; report: Report }> {
  const { id } = ok(await create(as, loc, rows, extra), 201);
  const { report } = ok(await dryRun(as, id)) as unknown as { report: Report };
  ok(await start(as, id), 202);
  expect(sent.at(-1)).toEqual({ name: 'import-csv', data: { runId: id } });
  await work(as, id);
  return { run: await runOf(as, id), report };
}

const thingsIn = (loc: Loc) =>
  own<{
    id: string;
    name: string;
    quantity: string;
    notes: string | null;
    created_via: string;
    place: string;
    parent: string | null;
    purchased_on: string | null;
    price: string | null;
    currency: string | null;
    vendor: string | null;
    brand: string | null;
    tags: string[];
  }>(
    db,
    `SELECT t.id, t.name, t.quantity::text AS quantity, t.notes, t.created_via,
            p.name AS place, pp.name AS parent,
            pu.purchased_on::text AS purchased_on, pl.unit_price::text AS price,
            pu.currency::text AS currency, v.name AS vendor, b.name AS brand,
            coalesce((SELECT array_agg(g.name ORDER BY g.name) FROM public.thing_tags tt
                        JOIN public.tags g ON g.id = tt.tag_id WHERE tt.thing_id = t.id), '{}')
              AS tags
       FROM public.things t
       JOIN public.places p ON p.id = t.place_id
       LEFT JOIN public.places pp ON pp.id = p.parent_id
       LEFT JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
       LEFT JOIN public.purchases pu ON pu.id = pl.purchase_id
       LEFT JOIN public.vendors v ON v.id = pu.vendor_id
       LEFT JOIN public.brands b ON b.id = t.brand_id
      WHERE t.location_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.created_at, t.id`,
    [loc.id],
  );

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  louis = await person(t, db, 'louis');
  eve = await person(t, db, 'eve');
  home = await createLocation(t, db, ann, 'household', 'Home');
  shed = await createLocation(t, db, ann, 'essentials', 'Shed');
  await join(db, home.id, bob.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
});

describe('POST /api/v1/imports/csv', () => {
  // catalogue: POST /api/v1/imports/csv
  it('records a draft run with its rows, audited as import.create without the file contents', async () => {
    const res = await create(ann, home, [row({ Name: 'SECRET-ROW-CONTENT' })]);
    const run = ok(res, 201) as unknown as Run & Record<string, unknown>;
    expect(run).toMatchObject({
      locationId: home.id,
      source: 'csv',
      status: 'draft',
      progress: 0,
      total: 1,
      startedAt: null,
      error: null,
    });
    const events = (await auditOf(db, home.id)).filter((e) => e.action === 'import.create');
    expect(events.at(-1)).toMatchObject({ actor_type: 'user', actor_id: ann.userId });
    expect(JSON.stringify(events.at(-1)?.diff)).not.toContain('SECRET-ROW-CONTENT');
  });

  it('refuses a member (403), and is a 404 for someone who cannot see the location', async () => {
    expect((await create(louis, home, [row({ Name: 'Lamp' })])).statusCode).toBe(403);
    expect((await create(eve, home, [row({ Name: 'Lamp' })])).statusCode).toBe(404);
  });

  it('refuses 10,001 rows with 413, and takes 10,000', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => [`Thing ${i}`]);
    const one = { columns: ['Name'], mapping: { Name: 'name' } };
    const over = await create(ann, home, many(10_001), one);
    expect(over.statusCode, over.body).toBe(413);
    expect(over.json()).toMatchObject({ code: 'payload_too_large' });
    const at = await create(ann, home, many(10_000), one);
    expect(at.statusCode, at.body).toBe(201);
  });

  it('needs a name column, columns it names, and single fields mapped once', async () => {
    const bad: { columns: string[]; mapping: Record<string, string> }[] = [
      { columns: ['A'], mapping: { A: 'notes' } },
      { columns: ['A'], mapping: { A: 'name', B: 'notes' } },
      { columns: ['A', 'B'], mapping: { A: 'name', B: 'name' } },
      { columns: ['A'], mapping: { A: 'owner_account_id' } },
    ];
    for (const b of bad) {
      expect((await create(ann, home, [['x', 'y']], b)).statusCode).toBe(400);
    }
    const twoNotes = { columns: ['A', 'B', 'C'], mapping: { A: 'name', B: 'notes', C: 'notes' } };
    expect((await create(ann, home, [['x', 'y', 'z']], twoNotes)).statusCode).toBe(201);
  });
});

describe('the dry run and the import', () => {
  let report: Report;
  let run: Run;
  let things: Awaited<ReturnType<typeof thingsIn>>;
  const FORMULA = '=HYPERLINK("https://evil.example","Click")';

  beforeAll(async () => {
    ({ run, report } = await importRows(ann, home, [
      row({
        Name: 'Kettle',
        Place: 'المطبخ > الرف',
        Qty: '٣٤٥',
        Bought: '12/03/2024',
        Price: '١٬٢٠٠٫٥٠',
        Shop: 'Carrefour',
        Code: 'hb-001',
        Brand: 'Tefal',
        Tags: 'kitchen، مطبخ',
      }),
      row({ Name: 'Toaster', Place: 'المطبخ > الرف', Bought: '31/02/2024', Price: '300' }),
      row({ Name: FORMULA, Notes: '+SUM(A1:A9)', Type: 'No such type' }),
      row({ Place: 'Garage' }),
      row({
        Name: 'Kettle',
        Place: 'المطبخ > الرف',
        Qty: '٣٤٥',
        Bought: '12/03/2024',
        Price: '١٬٢٠٠٫٥٠',
        Shop: 'Carrefour',
        Code: 'hb-001',
        Brand: 'Tefal',
        Tags: 'kitchen، مطبخ',
      }),
    ]));
    things = await thingsIn(home);
  }, LONG);

  it('reports each row: mapped, as text, skipped, and why (§5)', () => {
    expect(report.summary).toEqual({
      things: 3,
      places: 2,
      purchases: 1,
      legacyCodes: 1,
      skipped: 2,
      asText: 2,
    });
    expect(report.rows.map((r) => r.status)).toEqual(['ok', 'text', 'text', 'skipped', 'skipped']);
    expect(report.rows[1]?.issues).toContainEqual({
      column: 'Bought',
      code: 'not_date',
      params: { format: 'DD/MM/YYYY' },
      message: 'Not a date as DD/MM/YYYY.',
    });
    expect(report.rows[2]?.issues).toContainEqual({
      column: 'Type',
      code: 'type_not_found',
      message: 'No type has this name.',
    });
    expect(report.rows[3]?.issues).toEqual([
      { column: 'Name', code: 'no_name', message: 'No name.' },
    ]);
    expect(report.rows[4]?.issues).toEqual([
      { column: '', code: 'same_as_row', params: { row: 1 }, message: 'The same as row 1.' },
    ]);
    // Every issue carries one of the shared codes, for the web to translate.
    for (const i of report.rows.flatMap((r) => r.issues)) {
      expect(IMPORT_ISSUE_CODES).toContain(i.code);
    }
  });

  it('finishes done, clears the rows, and makes exactly what the dry run said', async () => {
    expect(run).toMatchObject({ status: 'done', progress: 5, total: 5, error: null });
    const [rows] = await own<{ rows: unknown }>(
      db,
      'SELECT rows FROM public.import_runs WHERE id = $1',
      [run.id],
    );
    expect(rows?.rows).toBeNull();
    expect(things.map((x) => x.name)).toEqual(['Kettle', 'Toaster', FORMULA]);
    expect(things.every((x) => x.created_via === 'import')).toBe(true);
  });

  it('creates the Arabic place path المطبخ > الرف, once', async () => {
    expect(things[0]).toMatchObject({ place: 'الرف', parent: 'المطبخ' });
    expect(things[1]).toMatchObject({ place: 'الرف', parent: 'المطبخ' });
    const places = await own<{ name: string; kind_key: string }>(
      db,
      `SELECT name, kind_key FROM public.places WHERE location_id = $1 AND name IN ('المطبخ', 'الرف')
        ORDER BY name`,
      [home.id],
    );
    expect(places).toEqual([
      { name: 'الرف', kind_key: 'zone' },
      { name: 'المطبخ', kind_key: 'room' },
    ]);
  });

  it('reads DD/MM/YYYY dates and Eastern Arabic digits', () => {
    expect(things[0]).toMatchObject({
      quantity: '345.000',
      purchased_on: '2024-03-12',
      price: '1200.5000',
      currency: 'EGP',
      vendor: 'Carrefour',
      brand: 'Tefal',
      tags: ['kitchen', 'مطبخ'],
    });
    // 31/02 isn't a date: no purchase, and both cells kept as text.
    expect(things[1]).toMatchObject({ purchased_on: null });
    expect(things[1]?.notes).toBe('Bought: 31/02/2024\nPrice: 300');
  });

  it('stores formula-looking cells as plain text, exactly as typed', () => {
    expect(things[2]?.name).toBe(FORMULA);
    expect(things[2]?.notes).toBe('+SUM(A1:A9)\nType: No such type');
  });

  it('keeps legacy codes in legacy_codes (source csv), stored upper-cased', async () => {
    const codes = await own<{ source: string; code: string; thing_id: string }>(
      db,
      'SELECT source, code, thing_id FROM public.legacy_codes WHERE location_id = $1',
      [home.id],
    );
    expect(codes).toEqual([{ source: 'csv', code: 'HB-001', thing_id: things[0]?.id }]);
  });

  it('resolves an imported legacy code through scan (T17)', async () => {
    const res = ok(await call(t, '/api/v1/scan/resolve', { as: ann, body: { text: 'hb-001' } }));
    expect(res).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: things[0]?.id, locationId: home.id },
    });
  });

  it('records each thing’s source id, and one import.run event per chunk with its subjects', async () => {
    const ids = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.import_source_ids WHERE run_id = $1`,
      [run.id],
    );
    expect(ids[0]?.n).toBe(3);
    const events = await own<{
      action: string;
      actor_id: string;
      diff: Record<string, { after: unknown }>;
      subjects: string[];
    }>(
      db,
      `SELECT e.action, e.actor_id, e.diff,
              array(SELECT s.thing_id::text FROM public.audit_event_subjects s
                     WHERE s.event_id = e.id ORDER BY s.thing_id) AS subjects
         FROM public.audit_events e WHERE e.entity_id = $1 ORDER BY e.at, e.id`,
      [run.id],
    );
    expect(events.map((e) => e.action)).toEqual([
      'import.create',
      'import.check',
      'import.start',
      'import.run',
    ]);
    const chunk = events[3];
    expect(chunk?.actor_id).toBe(ann.userId);
    expect(chunk?.diff.things?.after).toBe(3);
    expect(chunk?.diff.skipped?.after).toBe(2);
    expect(chunk?.subjects).toEqual(things.map((x) => x.id).sort());
    // Each thing's own history says it was created.
    const created = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.audit_events
        WHERE action = 'thing.create' AND request_id = $1`,
      [`import:${run.id}`],
    );
    expect(created[0]?.n).toBe(3);
  });

  it('a re-run of the same file creates nothing new', async () => {
    const again = await importRows(ann, home, [
      row({
        Name: 'Kettle',
        Place: 'المطبخ > الرف',
        Qty: '٣٤٥',
        Bought: '12/03/2024',
        Price: '١٬٢٠٠٫٥٠',
        Shop: 'Carrefour',
        Code: 'hb-001',
        Brand: 'Tefal',
        Tags: 'kitchen، مطبخ',
      }),
      row({ Name: 'Toaster', Place: 'المطبخ > الرف', Bought: '31/02/2024', Price: '300' }),
      row({ Name: FORMULA, Notes: '+SUM(A1:A9)', Type: 'No such type' }),
    ]);
    expect(again.report.summary).toMatchObject({ things: 0, places: 0, skipped: 3 });
    expect(again.report.rows[0]?.issues).toEqual([
      { column: '', code: 'already_imported', message: 'Already imported.' },
    ]);
    expect(again.run.status).toBe('done');
    expect(await thingsIn(home)).toHaveLength(things.length);
  });

  it('shows the run with its report to owners and admins only', async () => {
    const seen = await runOf(bob, run.id);
    expect(seen.report?.summary.things).toBe(3);
    expect((await call(t, `/api/v1/imports/${run.id}`, { as: louis })).statusCode).toBe(404);
    expect((await call(t, `/api/v1/imports/${run.id}`, { as: eve })).statusCode).toBe(404);
    const list = ok(
      await call(t, `/api/v1/imports?locationId=${home.id}`, { as: bob }),
    ) as unknown as {
      items: Run[];
    };
    expect(list.items.some((r) => r.id === run.id)).toBe(true);
    expect(list.items.every((r) => r.report === undefined)).toBe(true);
    const none = ok(
      await call(t, `/api/v1/imports?locationId=${home.id}`, { as: louis }),
    ) as unknown as {
      items: Run[];
    };
    expect(none.items).toEqual([]);
  });
});

describe('POST /api/v1/imports/:id/dry-run', () => {
  // catalogue: POST /api/v1/imports/:id/dry-run
  it('moves a draft to checked, audited as import.check with the summary', async () => {
    const { id } = ok(await create(ann, home, [row({ Name: 'Chair' })]), 201);
    const { report } = ok(await dryRun(ann, id)) as unknown as { report: Report };
    expect(report.summary.things).toBe(1);
    expect((await runOf(ann, id)).status).toBe('checked');
    const events = (await auditOf(db, home.id)).filter((e) => e.action === 'import.check');
    expect(events.at(-1)?.diff).toMatchObject({ status: { before: 'draft', after: 'checked' } });
    expect((await dryRun(louis, id)).statusCode).toBe(404);
  });

  it('keeps money as text where the money module is off', async () => {
    const { run } = await importRows(ann, shed, [
      row({ Name: 'Mower', Price: '5000', Bought: '01/02/2025' }),
    ]);
    expect(run.status).toBe('done');
    const [mower] = await thingsIn(shed);
    expect(mower).toMatchObject({ name: 'Mower', purchased_on: null });
    expect(mower?.notes).toBe('Bought: 01/02/2025\nPrice: 5000');
  });
});

describe('POST /api/v1/imports/:id/run', () => {
  // catalogue: POST /api/v1/imports/:id/run
  it('starts a checked run (202, the tenant job sent, audited as import.start); a draft is 409', async () => {
    const { id } = ok(await create(ann, home, [row({ Name: 'Desk' })]), 201);
    expect((await start(ann, id)).statusCode).toBe(409);
    ok(await dryRun(ann, id));
    const res = await start(bob, id);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ status: 'running' });
    expect(sent.at(-1)).toEqual({ name: 'import-csv', data: { runId: id } });
    const events = (await auditOf(db, home.id)).filter((e) => e.action === 'import.start');
    expect(events.at(-1)).toMatchObject({ actor_id: bob.userId });
    expect((await start(bob, id)).statusCode).toBe(409);
  });

  it(
    'resumes a failed run from where it stopped',
    async () => {
      const rows = Array.from({ length: CHUNK + 5 }, (_, i) => row({ Name: `Box ${i + 1}` }));
      const { id } = ok(await create(ann, home, rows), 201);
      ok(await dryRun(ann, id));
      ok(await start(ann, id), 202);
      const scope = { userId: ann.userId, mfa: false };
      await withScope(db.pools.app, scope, (tx, client) => importChunk(tx, client, scope, id));
      await own(db, `UPDATE public.import_runs SET status = 'failed', error = 'x' WHERE id = $1`, [
        id,
      ]);
      expect(await runOf(ann, id)).toMatchObject({ status: 'failed', progress: CHUNK });
      ok(await start(ann, id), 202);
      await work(ann, id);
      expect(await runOf(ann, id)).toMatchObject({
        status: 'done',
        progress: CHUNK + 5,
        error: null,
      });
      const boxes = (await thingsIn(home)).filter((x) => x.name.startsWith('Box '));
      expect(boxes).toHaveLength(CHUNK + 5);
    },
    LONG,
  );
});

describe('POST /api/v1/imports/:id/cancel', () => {
  // catalogue: POST /api/v1/imports/:id/cancel
  it(
    'stops the job at the next chunk, clears the rows, audited as import.cancel',
    async () => {
      const rows = Array.from({ length: CHUNK * 2 + 10 }, (_, i) => row({ Name: `Jar ${i + 1}` }));
      const { id } = ok(await create(ann, home, rows), 201);
      ok(await dryRun(ann, id));
      ok(await start(ann, id), 202);
      // The worker takes the first chunk, then the person cancels.
      const scope = { userId: ann.userId, mfa: false };
      const more = await withScope(db.pools.app, scope, (tx, client) =>
        importChunk(tx, client, scope, id),
      );
      expect(more).toBe(true);
      const res = await cancel(ann, id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ status: 'cancelled', progress: CHUNK });
      const events = (await auditOf(db, home.id)).filter((e) => e.action === 'import.cancel');
      expect(events.at(-1)?.diff).toMatchObject({
        status: { before: 'running', after: 'cancelled' },
      });
      // The job goes on to its next chunk, sees the cancel, and stops.
      await work(ann, id);
      expect(await runOf(ann, id)).toMatchObject({ status: 'cancelled', progress: CHUNK });
      const jars = (await thingsIn(home)).filter((x) => x.name.startsWith('Jar '));
      expect(jars).toHaveLength(CHUNK);
      // A done or cancelled run stays as it is.
      expect((await cancel(ann, id)).json()).toMatchObject({ status: 'cancelled' });
      expect((await cancel(louis, id)).statusCode).toBe(404);
    },
    LONG,
  );
});

describe('legacy codes (D146, D208)', () => {
  it('refuses a code already on something else in the location, whatever its source', async () => {
    const [other] = await thingsIn(home);
    await own(
      db,
      `INSERT INTO public.legacy_codes (location_id, source, code, thing_id)
       VALUES ($1, 'homebox', 'SHELF-9', $2)`,
      [home.id, other?.id],
    );
    const { report } = await importRows(ann, home, [
      row({ Name: 'Ladder', Code: ' shelf-9 ' }),
      row({ Name: 'Rope', Code: 'NEW-1' }),
      row({ Name: 'Hook', Code: 'new-1' }),
    ]);
    const taken = {
      column: 'Code',
      code: 'code_taken',
      message: 'This code is already on something else.',
    };
    expect(report.rows.map((r) => r.issues)).toEqual([[taken], [], [taken]]);
    const codes = await own<{ code: string; name: string }>(
      db,
      `SELECT c.code, t.name FROM public.legacy_codes c JOIN public.things t ON t.id = c.thing_id
        WHERE c.location_id = $1 AND c.code IN ('SHELF-9', 'NEW-1') ORDER BY c.code`,
      [home.id],
    );
    expect(codes).toEqual([
      { code: 'NEW-1', name: 'Rope' },
      { code: 'SHELF-9', name: other?.name },
    ]);
  });

  it('takes a client id within ±7 days, and refuses one outside', async () => {
    const id = newId();
    const res = await call(t, '/api/v1/imports/csv', {
      as: ann,
      body: {
        id,
        locationId: home.id,
        columns: ['Name'],
        rows: [['Pan']],
        mapping: { Name: 'name' },
        choices: choices(),
      },
    });
    expect(ok(res, 201).id).toBe(id);
  });
});

describe('own codes (T17a, D208)', () => {
  it('maps an own-code column: checked against the format rule at import, kept as text when it fails, and resolved by scan', async () => {
    await own(
      db,
      `INSERT INTO public.own_code_settings (location_id, rule_pattern, rule_message, rule_example)
       VALUES ($1, 'H-[0-9]{3}', 'H, a hyphen and three digits.', 'H-001')
       ON CONFLICT (location_id) DO UPDATE
         SET rule_pattern = EXCLUDED.rule_pattern, rule_message = EXCLUDED.rule_message,
             rule_example = EXCLUDED.rule_example`,
      [home.id],
    );
    const columns = ['Name', 'Mine'];
    const mapping = { Name: 'name', Mine: 'own_code' };
    const { report } = await importRows(
      ann,
      home,
      [
        ['Ladder', 'h-101'],
        ['Hose', 'HOSE'],
      ],
      { columns, mapping },
    );
    expect(report.rows.map((r) => [r.status, r.issues.map((i) => i.code)])).toEqual([
      ['ok', []],
      ['text', ['code_format']],
    ]);
    expect(report.rows[1]?.issues[0]).toMatchObject({
      column: 'Mine',
      params: { rule: 'H, a hyphen and three digits.' },
      message: 'H, a hyphen and three digits.',
    });
    const rows = await own<{ code: string; source: string; name: string }>(
      db,
      `SELECT c.code, c.source, t.name FROM public.legacy_codes c
         JOIN public.things t ON t.id = c.thing_id
        WHERE c.location_id = $1 AND t.name IN ('Ladder', 'Hose') ORDER BY c.code`,
      [home.id],
    );
    expect(rows).toEqual([{ code: 'H-101', source: 'own', name: 'Ladder' }]);
    const hose = await own<{ notes: string | null }>(
      db,
      `SELECT notes FROM public.things WHERE location_id = $1 AND name = 'Hose'`,
      [home.id],
    );
    expect(hose[0]?.notes).toContain('Mine: HOSE');
    const scanned = ok(await call(t, '/api/v1/scan/resolve', { as: bob, body: { text: 'H-101' } }));
    expect(scanned).toMatchObject({ outcome: 'open', target: { kind: 'thing' } });
    // A code the location already has, under any source, is refused at import too.
    const again = await importRows(ann, home, [['Rake', 'H-101']], { columns, mapping });
    expect(again.report.rows[0]?.issues.map((i) => i.code)).toEqual(['code_taken']);
    await own(db, 'DELETE FROM public.own_code_settings WHERE location_id = $1', [home.id]);
  });
});
