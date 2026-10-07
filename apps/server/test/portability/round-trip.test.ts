import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EXPORT_PATHS, type ExportEntity, type ExportHistoryEvent } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { open, type Sealed } from '../../src/crypto/envelope.js';
import { fixedSecretKeys, keyringOf } from '../../src/crypto/keyring.js';
import { type Scope, withScope } from '../../src/db/scope.js';
import { readEntity } from '../../src/exports/data.js';
import { HistoryEventSchema } from '../../src/exports/format.js';
import { buildExport } from '../../src/exports/job.js';
import { entityDef, REGISTRY } from '../../src/exports/registry.js';
import { createExport } from '../../src/exports/service.js';
import { Known, SOURCE_ID_TYPES } from '../../src/imports/kept/apply.js';
import { doorEventOf } from '../../src/imports/kept/history.js';
import { importedId, isUuid } from '../../src/imports/kept/ids.js';
import { runKeptImport } from '../../src/imports/kept/job.js';
import { openKeptArchive, readManifest } from '../../src/imports/kept/read.js';
import { unlockSecrets } from '../../src/imports/kept/secrets.js';
import { createLocation } from '../../src/locations/create.js';
import { resolveScan } from '../../src/scan/resolve.js';
import { aadOf } from '../../src/secrets/service.js';
import { runSeed } from '../../src/seed/index.js';
import { exportKey } from '../../src/storage/blob-store.js';
import type { TestApp } from '../app.js';
import { type TestDb, testDb } from '../db.js';
import { type TestFiles, testFiles } from '../files.js';
import { stageKeptRun } from '../kept-export.js';
import { peopleApp, person, recordingQueue } from '../people.js';
import { ownerTx } from '../tenancy.js';

// D69: "An export → import round-trip test runs in CI" (step-7 plan T14). Home, as the households
// seed makes it, is exported by Ibrahim with its secrets (the real export job, T12), then
// imported (the real import job, T14):
// 1. on the same server, as a new location of Alfred's: every code is taken there, so each label
//    is re-issued and its old code kept as a `kept` legacy code (Q9);
// 2. on another server (a fresh database and blob store), by a new person: every code is free,
//    so every label is kept as printed.
// Each import is compared with Home through a canonical projection: every exported entity read
// back by the export's own reader, ids replaced by the source ids they came from, creation and
// update times and `created_via` left out (an import is the importing person's, Q11). Then: file
// bytes, secrets revealed, the history carried, old labels scanned, and a second run that makes
// nothing.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const PASSPHRASE = 'olive kettle forty two';
const keys = fixedSecretKeys(keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }));
const env = {
  KEPT_PUBLIC_URL: 'http://localhost:5173',
  KEPT_AUTH_SECRET: randomBytes(32).toString('base64url'),
};
const log = { info: () => {}, error: () => {} };

let db: TestDb;
let db2: TestDb;
let files: TestFiles;
let files2: TestFiles;
let t2: TestApp;
let ibrahim: Scope;
let alfred: Scope;
let home: string;
let archive: { file: string; bytes: number; sha256: string; dir: string };

const own = <T extends Record<string, unknown>>(d: TestDb, sql: string, values: unknown[] = []) =>
  ownerTx(d, async (c) => (await c.query<T>(sql, values)).rows);

const userOf = async (email: string) =>
  (await own<{ id: string }>(db, 'SELECT id FROM auth."user" WHERE email = $1', [email]))[0]
    ?.id as string;

const acknowledgeKit = (d: TestDb) =>
  own(
    d,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );

async function newLocation(d: TestDb, scope: Scope, name: string): Promise<string> {
  return withScope(d.pools.app, scope, (tx, client) =>
    createLocation(
      { tx, client, scope, requestId: 'round-trip' },
      {
        name,
        kind: 'home',
        preset: 'essentials',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        rooms: [],
      },
    ),
  );
}

/** Imports the archive into `locationId` as `scope` on `d`, with the passphrase; the run's id. */
async function importInto(d: TestDb, f: TestFiles, scope: Scope, locationId: string) {
  const manifest = { keptVersion: 'round-trip' } as never;
  const runId = await stageKeptRun(
    d,
    f,
    { ...archive, manifest },
    {
      userId: scope.userId,
      locationId,
      status: 'checked',
    },
  );
  await unlockSecrets({ pools: d.pools, files: f, keys }, scope, runId, PASSPHRASE, 'round-trip');
  await own(d, `UPDATE public.import_runs SET status = 'running' WHERE id = $1`, [runId]);
  await runKeptImport({ pools: d.pools, files: f, keys, log }, scope, runId);
  const [run] = await own<{ status: string; error: string | null; created_at: Date }>(
    d,
    'SELECT status, error, created_at FROM public.import_runs WHERE id = $1',
    [runId],
  );
  expect(run).toMatchObject({ status: 'done', error: null });
  return { runId, createdAt: run ? run.created_at.getTime() : 0 };
}

type Rows = Map<ExportEntity, Record<string, unknown>[]>;

/** Every exported entity of `locationId`, read as `scope` by the export's own reader. */
async function project(d: TestDb, scope: Scope, locationId: string): Promise<Rows> {
  return withScope(d.pools.app, scope, async (_tx, client) => {
    const [loc] = (
      await client.query<{ account: string }>(
        'SELECT owner_account_id AS account FROM public.locations WHERE id = $1',
        [locationId],
      )
    ).rows;
    const ctx = {
      locationId,
      accountId: loc?.account as string,
      showMoney: true,
      ended: true,
      trashed: false,
    };
    const out: Rows = new Map();
    for (const def of REGISTRY) {
      const rows: Record<string, unknown>[] = [];
      for await (const r of readEntity(client, def, ctx)) rows.push(r);
      out.set(def.entity, rows);
    }
    return out;
  });
}

const IGNORED = new Set(['createdAt', 'updatedAt', 'createdVia', 'receivedAt']);

/** A row with every id it names replaced through `back` (new id → source id). */
function canonical(row: Record<string, unknown>, back: Map<string, string>): string {
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') return isUuid(v) ? (back.get(v.toLowerCase()) ?? v) : v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, swap(x)]),
      );
    }
    return v;
  };
  const kept = Object.fromEntries(Object.entries(row).filter(([k]) => !IGNORED.has(k)));
  return JSON.stringify(swap(kept));
}

/** new id → source id: the run's derived ids, then what import_source_ids recorded, then the
 * built-ins by key. */
async function backMap(
  d: TestDb,
  run: { runId: string; createdAt: number },
  source: Rows,
): Promise<Map<string, string>> {
  const back = new Map<string, string>();
  for (const rows of source.values()) {
    for (const r of rows) {
      if (typeof r.id === 'string') {
        back.set(importedId(run.runId, r.id, run.createdAt), r.id.toLowerCase());
      }
    }
  }
  for (const r of await own<{ source_id: string; entity_id: string }>(
    d,
    'SELECT source_id, entity_id FROM public.import_source_ids WHERE run_id = $1',
    [run.runId],
  )) {
    back.set(r.entity_id, r.source_id);
  }
  const theirs = await own<{ key: string; id: string }>(
    db,
    'SELECT builtin_key AS key, id FROM public.types WHERE owner_account_id IS NULL',
  );
  const ours = new Map(
    (
      await own<{ key: string; id: string }>(
        d,
        'SELECT builtin_key AS key, id FROM public.types WHERE owner_account_id IS NULL',
      )
    ).map((r) => [r.key, r.id]),
  );
  for (const r of theirs) {
    const id = ours.get(r.key);
    if (id) back.set(id, r.id);
  }
  return back;
}

function compare(
  source: Rows,
  imported: Rows,
  back: Map<string, string>,
  only: (e: ExportEntity) => boolean,
): void {
  for (const [entity, rows] of source) {
    if (!only(entity)) continue;
    const want = rows.map((r) => canonical(r, new Map())).sort();
    const got = (imported.get(entity) ?? []).map((r) => canonical(r, back)).sort();
    expect(got, entity).toEqual(want);
  }
}

/** Location-scoped entities, without the location row (its name and settings are the target's)
 * and the codes (which differ on the same server, Q9). */
const LOCATION_ROWS = (e: ExportEntity) =>
  entityDef(e)?.scope === 'location' && e !== 'codes' && e !== 'legacy-codes';

let source: Rows;
let history: ExportHistoryEvent[];

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  await runSeed('households', env, db.pools as never, { files, app: { secretKeys: keys } });
  await acknowledgeKit(db);
  ibrahim = { userId: await userOf('ibrahim@kept.test'), mfa: true };
  alfred = { userId: await userOf('alfred@kept.test'), mfa: true };
  home = (
    await own<{ id: string }>(
      db,
      `SELECT l.id FROM public.locations l JOIN public.owner_accounts a ON a.id = l.owner_account_id
        WHERE a.user_id = $1 AND l.name = 'Home'`,
      [ibrahim.userId],
    )
  )[0]?.id as string;

  // Ibrahim exports Home with its secrets, through the export's own service and job.
  const exportId = await withScope(db.pools.app, ibrahim, async (tx, client) => {
    const view = await createExport(
      tx,
      client,
      ibrahim,
      { jobs: recordingQueue([]), secretKeys: keys, files },
      {
        scope: { locationId: home },
        includeSecrets: true,
        passphrase: PASSPHRASE,
        passphraseAgain: PASSPHRASE,
      } as never,
      'round-trip',
    );
    return view.id;
  });
  const outcome = await buildExport(
    { pools: db.pools, files, secretKeys: keys, publicUrl: env.KEPT_PUBLIC_URL, log },
    ibrahim,
    { exportId },
  );
  expect(outcome.status).toBe('done');
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-round-trip-'));
  const file = path.join(dir, 'home.zip');
  const hash = createHash('sha256');
  const stream = await files.blobs.stream(exportKey(exportId));
  stream.on('data', (c: Buffer) => hash.update(c));
  await pipeline(stream, createWriteStream(file));
  archive = { file, bytes: (await stat(file)).size, sha256: hash.digest('hex'), dir };

  source = await project(db, ibrahim, home);
  // The history as exported.
  const runId = await stageKeptRun(
    db,
    files,
    { ...archive, manifest: { keptVersion: 'x' } as never },
    {
      userId: ibrahim.userId,
      locationId: home,
      status: 'draft',
    },
  );
  const opened = await openKeptArchive(files.blobs, runId, archive.bytes);
  history = [];
  try {
    await readManifest(opened);
    for await (const e of opened.ndjson(EXPORT_PATHS.data('history'), HistoryEventSchema)) {
      history.push(e as ExportHistoryEvent);
    }
  } finally {
    opened.close();
  }

  db2 = await testDb('b');
  await db2.reset();
  files2 = await testFiles();
  await acknowledgeKit(db2);
  t2 = await peopleApp(db2, { files: files2, secretKeys: keys });
});

afterAll(async () => {
  await t2?.app.close();
  await files?.cleanup();
  await files2?.cleanup();
  if (archive) await rm(archive.dir, { recursive: true, force: true });
});

/** The history events an import carries: what the door takes, within the retention. */
function carriedCount(): number {
  const known = new Known();
  known.add(home);
  for (const rows of source.values()) for (const r of rows) known.add(r.id);
  const ids = { of: (x: string) => x, ref: (x: string | null) => x } as never;
  return history.filter((e) => doorEventOf(e, ids, known, Date.now()) !== null).length;
}

/** Each secret of Home, revealed by `scope` in `locationId`, by source subject and field. */
async function secretsOf(d: TestDb, scope: Scope, locationId: string, back: Map<string, string>) {
  const rows = await withScope(
    d.pools.app,
    scope,
    async (_tx, client) =>
      (
        await client.query<{ id: string; subject: string; field_key: string; ciphertext: Sealed }>(
          `SELECT id, coalesce(thing_id, place_id) AS subject, field_key, ciphertext
           FROM public.secret_values WHERE location_id = $1 AND superseded_at IS NULL`,
          [locationId],
        )
      ).rows,
  );
  return rows
    .map(
      (r) =>
        `${back.get(r.subject) ?? r.subject}|${r.field_key}|${open(keys.get().keyring, r.ciphertext, aadOf(r.id, r.field_key)).toString('utf8')}`,
    )
    .sort();
}

describe('export → import round trip (D69)', () => {
  it('on the same server: everything as it was, labels re-issued with their old codes kept', async () => {
    const target = await newLocation(db, alfred, 'Home, moved');
    const run = await importInto(db, files, alfred, target);
    const back = await backMap(db, run, source);
    const imported = await project(db, alfred, target);
    compare(source, imported, back, LOCATION_ROWS);

    // Every old code opens the same thing (through a `kept` legacy code), and is re-issued.
    const codes = source.get('codes') ?? [];
    const assigned = codes.filter((c) => c.state === 'assigned' && c.thingId);
    expect(assigned.length).toBeGreaterThan(0);
    for (const c of assigned) {
      const outcome = await withScope(db.pools.app, alfred, (_tx, client) =>
        resolveScan(
          client,
          { text: `https://kept.old.example/l/${c.code}` },
          {
            lookupEnabled: async () => false,
          },
        ),
      );
      expect(outcome.outcome, String(c.code)).toBe('open');
      const id = (outcome as { target: { id: string } }).target.id;
      // Alfred is a member of Home too, so the code still opens Home's own thing for him (a
      // short ID wins over a legacy code); the new location keeps it as a `kept` legacy code.
      expect(id === c.thingId || back.get(id) === c.thingId, String(c.code)).toBe(true);
      const [legacy] = await own<{ thing_id: string }>(
        db,
        `SELECT thing_id FROM public.legacy_codes
          WHERE location_id = $1 AND source = 'kept' AND code = $2`,
        [target, c.code],
      );
      expect(back.get(legacy?.thing_id ?? ''), String(c.code)).toBe(c.thingId);
    }

    expect(await secretsOf(db, alfred, target, back)).toEqual(
      await secretsOf(db, ibrahim, home, new Map()),
    );
    const [events] = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.audit_events
        WHERE location_id = $1 AND actor_type = 'import'`,
      [target],
    );
    expect(events?.n).toBe(carriedCount());
  });

  it('on another server: every entity, file, label, secret and event as it was', async () => {
    const fresh = await person(t2, db2, 'newcomer');
    const scope = { userId: fresh.userId, mfa: true };
    const target = await newLocation(db2, scope, 'Home');
    const run = await importInto(db2, files2, scope, target);
    const back = await backMap(db2, run, source);
    const imported = await project(db2, scope, target);
    // Every entity: the account's registries too (the new person had none), and the codes as
    // printed (all free here).
    compare(source, imported, back, (e) => e !== 'location');

    // The originals, byte for byte.
    const sha = (rows: Record<string, unknown>[] | undefined) =>
      (rows ?? []).map((r) => String(r.sha256)).sort();
    expect(sha(imported.get('files'))).toEqual(sha(source.get('files')));
    expect((source.get('files') ?? []).length).toBeGreaterThan(0);

    // An old label scanned here opens the same thing.
    for (const c of (source.get('codes') ?? []).filter(
      (x) => x.state === 'assigned' && x.thingId,
    )) {
      const outcome = await withScope(db2.pools.app, scope, (_tx, client) =>
        resolveScan(
          client,
          { text: `https://kept.old.example/l/${c.code}` },
          {
            lookupEnabled: async () => false,
          },
        ),
      );
      expect(back.get((outcome as { target: { id: string } }).target.id)).toBe(c.thingId);
    }

    expect(await secretsOf(db2, scope, target, back)).toEqual(
      await secretsOf(db, ibrahim, home, new Map()),
    );
    const [events] = await own<{ n: number }>(
      db2,
      `SELECT count(*)::int AS n FROM public.audit_events
        WHERE location_id = $1 AND actor_type = 'import'`,
      [target],
    );
    expect(events?.n).toBe(carriedCount());
    expect(
      (
        await own<{ n: number }>(db2, 'SELECT count(*)::int AS n FROM public.audit_events_default')
      )[0]?.n,
    ).toBe(0);

    // Every entity import_source_ids names is remembered, step 4–6's too (0097).
    const remembered = await own<{ entity_type: string }>(
      db2,
      'SELECT DISTINCT entity_type FROM public.import_source_ids WHERE run_id = $1',
      [run.runId],
    );
    const named = Object.entries(SOURCE_ID_TYPES)
      .filter(([e]) => (source.get(e as ExportEntity)?.length ?? 0) > 0)
      .map(([, type]) => type);
    expect(named).toEqual(expect.arrayContaining(['loan', 'claim', 'incident', 'valuation']));
    expect(remembered.map((r) => r.entity_type).sort()).toEqual(expect.arrayContaining(named));

    // Running the job again makes nothing.
    const before = await project(db2, scope, target);
    await runKeptImport({ pools: db2.pools, files: files2, keys, log }, scope, run.runId);
    expect(await project(db2, scope, target)).toEqual(before);
  });
});
