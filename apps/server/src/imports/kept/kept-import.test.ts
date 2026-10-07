import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { EXPORT_PATHS } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../test/app.js';
import { type TestDb, testDb } from '../../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../../test/files.js';
import { forgeKeptExport, stageKeptRun } from '../../../test/kept-export.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Loc,
  ok,
  own,
} from '../../../test/things.js';
import { forgeZip } from '../../../test/zip-forge.js';
import { open, type Sealed } from '../../crypto/envelope.js';
import { fixedSecretKeys, keyringOf } from '../../crypto/keyring.js';
import { withScope } from '../../db/scope.js';
import { AppError } from '../../http/errors.js';
import { ArchiveError } from '../../portability/zip/limits.js';
import { resolveScan } from '../../scan/resolve.js';
import { aadOf } from '../../secrets/service.js';
import { importArchiveKey } from '../../storage/blob-store.js';
import { runKeptImport } from './job.js';
import { keptDryRun } from './plan.js';
import { openKeptArchive, readManifest } from './read.js';
import { unlockSecrets } from './secrets.js';

// Step-7 T14: a Kept export imported into a new location (plan Q8), on the server it came from:
// every row remapped, labels re-issued with the old codes kept (Q9), files byte-identical, the
// secrets with the passphrase (D68), history carried as `import` events (Q10), and a resumed run
// that makes nothing twice. The export is made with the registry's own readers
// (test/kept-export.ts); the round trip through the export job is test/portability.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PASSPHRASE = 'correct horse battery staple';
const keys = fixedSecretKeys(keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }));

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person;
let alfred: Person;
let bruce: Person;
let home: Loc;
let shelf: string;
const ids: Record<string, string> = {};

const scopeOf = (p: Person) => ({ userId: p.userId, mfa: true });
const deps = () => ({ pools: db.pools, files, keys, log: { info: () => {}, error: () => {} } });

const running = (runId: string, progress?: number) =>
  own(
    db,
    `UPDATE public.import_runs SET status = 'running', started_at = now(),
            progress = coalesce($2, progress) WHERE id = $1`,
    [runId, progress ?? null],
  );

const runOf = async (runId: string) =>
  (
    await own<{
      status: string;
      progress: number;
      total: number | null;
      error: string | null;
      key: Sealed | null;
    }>(
      db,
      `SELECT status, progress, total, error, secrets_key_ciphertext AS key
         FROM public.import_runs WHERE id = $1`,
      [runId],
    )
  )[0];

const count = async (sql: string, values: unknown[]) =>
  Number((await own<{ n: string }>(db, sql, values))[0]?.n ?? 0);

async function newTarget(name: string): Promise<Loc> {
  return createLocation(t, db, alfred, 'complete', name);
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files, secretKeys: keys });
  ibrahim = await person(t, db, 'ibrahim');
  alfred = await person(t, db, 'alfred');
  bruce = await person(t, db, 'bruce');
  home = await createLocation(t, db, ibrahim, 'complete', 'Home');
  await join(db, home.id, bruce.userId, 'admin');
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );
  const shelfRes = await call(t, `/api/v1/locations/${home.id}/places`, {
    as: ibrahim,
    body: { parentId: null, name: 'Shelf', kindKey: 'room' },
  });
  shelf = ok(shelfRes, 201).id;
  const safeType = await builtinType(db, 'safe');
  const safe = await createThing(t, ibrahim, home, {
    name: 'Safe',
    typeId: safeType,
    placeId: shelf,
  });
  ids.safe = safe.id;
  const put = await call(t, `/api/v1/things/${safe.id}/secrets/combination`, {
    as: ibrahim,
    method: 'PUT',
    body: { value: '12-34-56' },
  });
  expect(put.statusCode, put.body).toBe(204);
  ids.passports = (
    await createThing(t, ibrahim, home, { name: 'Passports', containerId: safe.id })
  ).id;
  ids.drill = (
    await createThing(t, ibrahim, home, {
      name: 'Drill',
      typeId: await builtinType(db, 'power_tool'),
      purchase: { purchasedOn: '2026-01-10', currency: 'EGP', price: '1500' },
    })
  ).id;
  const up = await upload(t, ibrahim, home.id, await uniqueJpeg());
  expect(up.statusCode, up.body).toBe(201);
  ids.photo = (up.json() as { id: string }).id;
  const attach = await call(t, '/api/v1/attachments', {
    as: ibrahim,
    body: {
      locationId: home.id,
      fileId: ids.photo,
      subject: { thingId: ids.drill },
      role: 'photo',
    },
  });
  expect(attach.statusCode, attach.body).toBe(201);
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('a Kept export imported on the server it came from (plan T14)', () => {
  let target: Loc;
  let runId: string;
  let forged: Awaited<ReturnType<typeof forgeKeptExport>>;

  beforeAll(async () => {
    forged = await forgeKeptExport(db, {
      userId: ibrahim.userId,
      locationId: home.id,
      files,
      keys,
      passphrase: PASSPHRASE,
    });
    target = await newTarget('Home, moved');
    runId = await stageKeptRun(db, files, forged, {
      userId: alfred.userId,
      locationId: target.id,
      status: 'checked',
    });
  });

  afterAll(() => forged.cleanup());

  it('dry-runs: re-issued labels, files, secrets and history, writing nothing', async () => {
    const report = await withScope(db.pools.app, scopeOf(alfred), async (_tx, client) => {
      const archive = await openKeptArchive(files.blobs, runId, forged.bytes);
      try {
        return await keptDryRun(client, archive, target.id);
      } finally {
        archive.close();
      }
    });
    expect(report.summary).toMatchObject({
      things: 3,
      places: 1,
      attachments: 1,
      files: 1,
      codesAdopted: 0,
      codesReissued: 3,
      secrets: 1,
      members: [{ name: 'Bruce', role: 'admin' }],
    });
    expect(report.summary.history).toBeGreaterThan(0);
    expect(report.rows.map((r) => r.issues[0]?.code)).toEqual([
      'code_taken',
      'code_taken',
      'code_taken',
    ]);
    expect(
      await count('SELECT count(*) AS n FROM public.things WHERE location_id = $1', [target.id]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM public.short_ids WHERE location_id = $1', [target.id]),
    ).toBe(0);
  });

  it('checks the passphrase by decrypting, and seals the key onto the run', async () => {
    const wrong = await unlockSecrets(
      { pools: db.pools, files, keys },
      scopeOf(alfred),
      runId,
      'not the passphrase at all',
      'test',
    ).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(AppError);
    expect((wrong as AppError).code).toBe('passphrase_wrong');
    expect((await runOf(runId))?.key).toBeNull();
    await unlockSecrets(
      { pools: db.pools, files, keys },
      scopeOf(alfred),
      runId,
      PASSPHRASE,
      'test',
    );
    expect((await runOf(runId))?.key).not.toBeNull();
  });

  it('imports every row, remapped, with labels, files, secrets and history', async () => {
    await running(runId);
    await runKeptImport(deps(), scopeOf(alfred), runId);
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'done', error: null, key: null });
    expect(run?.progress).toBe(run?.total);
    expect(await files.blobs.exists(importArchiveKey(runId))).toBe(false);

    const map = new Map(
      (
        await own<{ source_id: string; entity_id: string }>(
          db,
          `SELECT source_id, entity_id FROM public.import_source_ids
            WHERE run_id = $1 AND entity_type IN ('thing', 'place', 'file')`,
          [runId],
        )
      ).map((r) => [r.source_id, r.entity_id]),
    );
    const safe = map.get(ids.safe as string) as string;
    const passports = map.get(ids.passports as string) as string;
    const drill = map.get(ids.drill as string) as string;
    expect([safe, passports, drill].every((x) => x && !Object.values(ids).includes(x))).toBe(true);
    const things = await own<{
      id: string;
      name: string;
      container_id: string | null;
      place_id: string | null;
      created_via: string;
    }>(
      db,
      `SELECT id, name, container_id, place_id, created_via FROM public.things
        WHERE location_id = $1 ORDER BY name`,
      [target.id],
    );
    expect(things.map((x) => x.name)).toEqual(['Drill', 'Passports', 'Safe']);
    expect(things.find((x) => x.id === passports)?.container_id).toBe(safe);
    expect(things.find((x) => x.id === safe)?.place_id).toBe(map.get(shelf));
    expect(new Set(things.map((x) => x.created_via))).toEqual(new Set(['import']));

    // Same server: every code is taken, so each thing has a new one and its old one as `kept`.
    const old = await own<{ code: string; thing_id: string }>(
      db,
      `SELECT code, thing_id FROM public.short_ids WHERE location_id = $1 AND thing_id IS NOT NULL`,
      [home.id],
    );
    expect(old).toHaveLength(3);
    for (const o of old) {
      const now = map.get(o.thing_id) as string;
      const [legacy] = await own<{ thing_id: string }>(
        db,
        `SELECT thing_id FROM public.legacy_codes
          WHERE location_id = $1 AND source = 'kept' AND code = $2`,
        [target.id, o.code],
      );
      expect(legacy?.thing_id).toBe(now);
      expect(
        await count(
          `SELECT count(*) AS n FROM public.short_ids
            WHERE thing_id = $1 AND is_primary AND state = 'assigned'`,
          [now],
        ),
      ).toBe(1);
      const opened = await withScope(db.pools.app, scopeOf(alfred), (_tx, c) =>
        resolveScan(
          c,
          { text: `https://kept.old.example/l/${o.code}` },
          {
            lookupEnabled: async () => false,
          },
        ),
      );
      expect(opened).toEqual({
        outcome: 'open',
        target: { kind: 'thing', id: now, locationId: target.id },
      });
    }

    // The photo: the same bytes, attached to the new drill.
    const [photo] = await own<{ sha256: string; thing_id: string }>(
      db,
      `SELECT f.sha256, a.thing_id FROM public.attachments a JOIN public.files f ON f.id = a.file_id
        WHERE a.location_id = $1`,
      [target.id],
    );
    const [source] = await own<{ sha256: string }>(
      db,
      'SELECT sha256 FROM public.files WHERE id = $1',
      [ids.photo],
    );
    expect(photo).toEqual({ sha256: source?.sha256, thing_id: drill });

    // The purchase came with the drill.
    const [bought] = await own<{ total: string; currency: string }>(
      db,
      `SELECT p.total::text AS total, p.currency FROM public.things t
         JOIN public.purchase_lines l ON l.id = t.purchase_line_id
         JOIN public.purchases p ON p.id = l.purchase_id WHERE t.id = $1`,
      [drill],
    );
    expect(bought).toEqual({ total: '1500.0000', currency: 'EGP' });

    // The secret, sealed under this server's keyring for its new row.
    const [value] = await own<{ id: string; field_key: string; ciphertext: Sealed }>(
      db,
      `SELECT id, field_key, ciphertext FROM public.secret_values
        WHERE thing_id = $1 AND superseded_at IS NULL`,
      [safe],
    );
    expect(value?.field_key).toBe('combination');
    expect(
      open(
        keys.get().keyring,
        value?.ciphertext as Sealed,
        aadOf(value?.id as string, 'combination'),
      ).toString('utf8'),
    ).toBe('12-34-56');

    // History: carried as `import` events of the run, named for who did it before.
    const carried = await own<{
      action: string;
      actor_id: string;
      diff: Record<string, unknown> | null;
    }>(
      db,
      `SELECT action, actor_id, diff FROM public.audit_events
        WHERE location_id = $1 AND actor_type = 'import' ORDER BY at, id`,
      [target.id],
    );
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.every((e) => e.actor_id === runId)).toBe(true);
    expect(carried.some((e) => e.action === 'thing.create')).toBe(true);
    expect(JSON.stringify(carried)).not.toContain('12-34-56');
    expect(await count('SELECT count(*) AS n FROM public.audit_events_default', [])).toBe(0);
  });

  it('does nothing when the job runs again for a done run', async () => {
    const before = await count(
      'SELECT count(*) AS n FROM public.audit_events WHERE location_id = $1',
      [target.id],
    );
    await runKeptImport(deps(), scopeOf(alfred), runId);
    expect(
      await count('SELECT count(*) AS n FROM public.audit_events WHERE location_id = $1', [
        target.id,
      ]),
    ).toBe(before);
  });
});

describe('POST /api/v1/imports/:id/passphrase', () => {
  // catalogue: POST /api/v1/imports/:id/passphrase
  it('checks the passphrase, answers the run unlocked, and audits import.passphrase', async () => {
    const forged = await forgeKeptExport(db, {
      userId: ibrahim.userId,
      locationId: home.id,
      files,
      keys,
      passphrase: PASSPHRASE,
    });
    try {
      const target = await newTarget('Home, by the route');
      const runId = await stageKeptRun(db, files, forged, {
        userId: alfred.userId,
        locationId: target.id,
        status: 'checked',
      });
      await own(db, 'UPDATE public.import_runs SET inspect = $2 WHERE id = $1', [
        runId,
        JSON.stringify({ source: 'kept_zip', kept: { includesSecrets: true } }),
      ]);
      const url = `/api/v1/imports/${runId}/passphrase`;
      const wrong = await call(t, url, { as: alfred, body: { passphrase: 'not this one, no' } });
      expect(wrong.statusCode, wrong.body).toBe(400);
      expect(wrong.json()).toMatchObject({ code: 'passphrase_wrong' });
      expect((await call(t, url, { as: bruce, body: { passphrase: PASSPHRASE } })).statusCode).toBe(
        404,
      );
      const right = ok(await call(t, url, { as: alfred, body: { passphrase: PASSPHRASE } }));
      expect(right.secrets).toEqual({ present: true, unlocked: true });
      expect(JSON.stringify(right)).not.toContain(PASSPHRASE);
      const events = (await auditOf(db, target.id)).filter((e) => e.action === 'import.passphrase');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(PASSPHRASE);
    } finally {
      await forged.cleanup();
    }
  });
});

describe('resuming and refusing', () => {
  it('a resumed run makes nothing twice', async () => {
    const forged = await forgeKeptExport(db, {
      userId: ibrahim.userId,
      locationId: home.id,
      files,
      mutate: (m, entries) => {
        // No history: a resume from the start would carry it twice (a real resume never starts
        // before what it already wrote: the batch and its progress commit together).
        entries.set(EXPORT_PATHS.data('history'), Buffer.from(''));
        m.counts.history = 0;
      },
    });
    try {
      const target = await newTarget('Home, resumed');
      const runId = await stageKeptRun(db, files, forged, {
        userId: alfred.userId,
        locationId: target.id,
      });
      await runKeptImport(deps(), scopeOf(alfred), runId);
      const tables = [
        'things',
        'places',
        'short_ids',
        'legacy_codes',
        'attachments',
        'files',
        'purchases',
      ];
      const counts = async () =>
        Promise.all(
          tables.map((x) =>
            count(`SELECT count(*) AS n FROM public.${x} WHERE location_id = $1`, [target.id]),
          ),
        );
      const first = await counts();
      await files.blobs.put(importArchiveKey(runId), forged.file, {
        contentType: 'application/zip',
        bytes: forged.bytes,
      });
      await running(runId, 2);
      await runKeptImport(deps(), scopeOf(alfred), runId);
      expect((await runOf(runId))?.status).toBe('done');
      expect(await counts()).toEqual(first);
      // The account's registries were matched, not made again.
      expect(
        await count(`SELECT count(*) AS n FROM public.types WHERE owner_account_id = $1`, [
          target.accountId,
        ]),
      ).toBe(0);
    } finally {
      await forged.cleanup();
    }
  });

  it('a file the export lacks is left out, and its thing imports without it', async () => {
    const forged = await forgeKeptExport(db, {
      userId: ibrahim.userId,
      locationId: home.id,
      files,
      mutate: (m, entries) => {
        for (const f of m.files) entries.delete(f.path);
      },
    });
    try {
      const target = await newTarget('Home, no photos');
      const runId = await stageKeptRun(db, files, forged, {
        userId: alfred.userId,
        locationId: target.id,
      });
      await runKeptImport(deps(), scopeOf(alfred), runId);
      expect((await runOf(runId))?.status).toBe('done');
      expect(
        await count('SELECT count(*) AS n FROM public.things WHERE location_id = $1', [target.id]),
      ).toBe(3);
      expect(
        await count('SELECT count(*) AS n FROM public.attachments WHERE location_id = $1', [
          target.id,
        ]),
      ).toBe(0);
      const skipped = await own<{ after: unknown }>(
        db,
        `SELECT diff->'skipped_rows'->'after' AS after FROM public.audit_events
          WHERE location_id = $1 AND action = 'import.run' AND diff ? 'skipped_rows'`,
        [target.id],
      );
      expect(JSON.stringify(skipped)).toContain('file_missing');
    } finally {
      await forged.cleanup();
    }
  });

  it('without the passphrase the import runs and the secrets are left out', async () => {
    const forged = await forgeKeptExport(db, {
      userId: ibrahim.userId,
      locationId: home.id,
      files,
      keys,
      passphrase: PASSPHRASE,
    });
    try {
      const target = await newTarget('Home, no secrets');
      const runId = await stageKeptRun(db, files, forged, {
        userId: alfred.userId,
        locationId: target.id,
        status: 'checked',
      });
      for (let i = 0; i < 3; i++) {
        await expect(
          unlockSecrets(
            { pools: db.pools, files, keys },
            scopeOf(alfred),
            runId,
            `wrong ${i} passphrase`,
            'test',
          ),
        ).rejects.toMatchObject({ code: 'passphrase_wrong' });
      }
      await running(runId);
      await runKeptImport(deps(), scopeOf(alfred), runId);
      expect((await runOf(runId))?.status).toBe('done');
      expect(
        await count('SELECT count(*) AS n FROM public.secret_values WHERE location_id = $1', [
          target.id,
        ]),
      ).toBe(0);
    } finally {
      await forged.cleanup();
    }
  });

  it('refuses a newer export, and a hostile archive', async () => {
    const forged = await forgeKeptExport(db, {
      userId: ibrahim.userId,
      locationId: home.id,
      files,
      mutate: (m) => {
        m.version = 99;
      },
    });
    try {
      const target = await newTarget('Home, from the future');
      const runId = await stageKeptRun(db, files, forged, {
        userId: alfred.userId,
        locationId: target.id,
      });
      const archive = await openKeptArchive(files.blobs, runId, forged.bytes);
      await expect(readManifest(archive)).rejects.toMatchObject({ reason: 'unsupported_version' });
      archive.close();
      await runKeptImport(deps(), scopeOf(alfred), runId);
      expect(await runOf(runId)).toMatchObject({
        status: 'failed',
        error: 'archive_invalid:unsupported_version',
      });
      expect(
        await count('SELECT count(*) AS n FROM public.things WHERE location_id = $1', [target.id]),
      ).toBe(0);
    } finally {
      await forged.cleanup();
    }

    const hostile = forgeZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      {
        name: 'data/things.ndjson',
        data: Buffer.from('/etc/passwd'),
        madeBy: 3,
        unixMode: 0o120777,
      },
    ]);
    const file = `${files.dir}/hostile.zip`;
    await writeFile(file, hostile);
    const runId = await stageKeptRun(
      db,
      files,
      {
        file,
        bytes: hostile.length,
        sha256: '0'.repeat(64),
        manifest: { keptVersion: 'x' } as never,
      },
      { userId: alfred.userId, locationId: (await newTarget('Home, hostile')).id },
    );
    const refused = await openKeptArchive(files.blobs, runId, hostile.length).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ArchiveError);
    expect((refused as ArchiveError).reason).toBe('symlink');
  });
});
