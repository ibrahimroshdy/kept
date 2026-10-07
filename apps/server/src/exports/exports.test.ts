import { randomBytes } from 'node:crypto';
import { mkdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import {
  EXPORT_ENTITIES,
  EXPORT_FILE_PATH,
  type ExportManifest,
  type ExportSecretRecord,
} from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  fixture,
  sha256,
  type TestFiles,
  testFiles,
  uniqueJpeg,
  upload,
} from '../../test/files.js';
import {
  auditOf,
  call,
  join,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
} from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import { runJob } from '../jobs/boss.js';
import {
  checkSecretsFile,
  decryptSecrets,
  keyForSecretsFile,
  PassphraseWrongError,
} from '../portability/passphrase.js';
import { exportKey } from '../storage/blob-store.js';
import { ManifestSchema } from './format.js';
import { buildExport, type ExportOutcome, exportJobs } from './job.js';
import { sweepExportScratch } from './purge.js';
import { EXPORTED_ENTITIES } from './registry.js';
import type { ExportRunView } from './service.js';

// Step 7, T12 and T13 (D68, D69, D110, D157, D159, D169, D180; plan Q5, Q7, Q12, Q14, Q17, Q22,
// Q23): the Kept export through the front door, its job run as the worker would, and the ZIP read
// back entry by entry.
//
// Ibrahim owns Home (Complete: money and secrets on). Bruce is an admin there, Louis a member and
// Talia a viewer. A safe in Home holds a secret combination; a thing is named like a formula.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let home: Loc;
let safe: string;
let photoSha: string;

const SECRET = 'SECRET-COMBINATION-4417';
const PASS = 'correct horse battery staple';
const keys = fixedSecretKeys(keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }));
const log = { info: () => {}, error: () => {} };
const deps = () => ({
  pools: db.pools,
  files,
  secretKeys: keys,
  publicUrl: 'https://kept.example',
  log,
});

type Entries = Map<string, Buffer>;

/** Every entry of a ZIP, inflated. */
function unzip(zip: Buffer): Promise<Entries> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, z) => {
      if (err || !z) return reject(err);
      const out: Entries = new Map();
      z.on('entry', (entry: yauzl.Entry) => {
        z.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            z.readEntry();
          });
        });
      });
      z.on('end', () => resolve(out));
      z.on('error', reject);
      z.readEntry();
    });
  });
}

const createExport = (as: Person, body: Record<string, unknown>) =>
  call(t, '/api/v1/exports', { as, body });

/** Starts an export and runs its job. */
async function exported(
  as: Person,
  body: Record<string, unknown>,
): Promise<{ id: string; outcome: ExportOutcome }> {
  const res = await createExport(as, body);
  expect(res.statusCode, res.body).toBe(202);
  const { id } = res.json() as ExportRunView;
  const outcome = await buildExport(deps(), { userId: as.userId, mfa: false }, { exportId: id });
  return { id, outcome };
}

async function zipOf(id: string): Promise<Entries> {
  const chunks: Buffer[] = [];
  for await (const c of await files.blobs.stream(exportKey(id))) chunks.push(c as Buffer);
  return unzip(Buffer.concat(chunks));
}

const text = (e: Entries, name: string) => e.get(name)?.toString('utf8') ?? '';
const lines = (e: Entries, name: string) =>
  text(e, name)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, {
    sent,
    files,
    secretKeys: keys,
    // An export is https only (D181); the refusal over http is tested below.
    publicUrl: 'https://kept.example',
  });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, bruce, 'Bruce');
  home = await createLocation(t, db, ibrahim, 'complete', 'Home');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );

  const study = await place(db, home, 'غرفة المكتب');
  safe = (
    await createThing(t, ibrahim, home, {
      name: 'Safe',
      placeId: study,
      typeId: await builtinType(db, 'safe'),
    })
  ).id;
  const put = await call(t, `/api/v1/things/${safe}/secrets/combination`, {
    as: ibrahim,
    method: 'PUT',
    body: { value: SECRET },
  });
  expect(put.statusCode, put.body).toBeLessThan(300);
  const tv = ok(
    await call(t, '/api/v1/things', {
      as: ibrahim,
      body: {
        locationId: home.id,
        placeId: study,
        name: 'Television',
        serial: 'SN-TV-0001',
        purchase: { purchasedOn: '2024-03-12', currency: 'EGP', price: '25000' },
      },
    }),
    201,
  ).id;
  ok(
    await call(t, '/api/v1/things', {
      as: ibrahim,
      body: { locationId: home.id, placeId: home.unplacedId, name: '=HYPERLINK("http://evil")' },
    }),
    201,
  );
  const photo = await fixture('photo.jpg');
  photoSha = sha256(photo);
  const up = await upload(t, ibrahim, home.id, photo);
  expect(up.statusCode, up.body).toBe(201);
  ok(
    await call(t, '/api/v1/attachments', {
      as: ibrahim,
      body: { locationId: home.id, fileId: up.json().id, subject: { thingId: tv }, role: 'photo' },
    }),
    201,
  );
});

afterAll(async () => {
  await files?.cleanup();
});

// Each case starts with an empty rate window and nothing running.
beforeEach(async () => {
  await own(
    db,
    `UPDATE public.export_runs SET created_at = created_at - interval '2 hours',
            started_at = started_at - interval '2 hours'
      WHERE created_at > now() - interval '1 hour'`,
  );
  await own(
    db,
    `UPDATE public.export_runs SET status = 'failed', error = 'test', finished_at = now(),
            secrets_key_ciphertext = NULL, key_version = NULL
      WHERE status IN ('queued', 'running')`,
  );
});

describe('who may export', () => {
  it('refuses a member and a viewer, and secrets from an admin', async () => {
    const scope = { locationId: home.id };
    expect((await createExport(louis, { scope })).statusCode).toBe(403);
    expect((await createExport(talia, { scope })).statusCode).toBe(403);
    const admin = await createExport(bruce, {
      scope,
      includeSecrets: true,
      passphrase: PASS,
      passphraseAgain: PASS,
    });
    expect(admin.statusCode).toBe(403);
    const weak = await createExport(ibrahim, {
      scope,
      includeSecrets: true,
      passphrase: 'short',
      passphraseAgain: 'short',
    });
    expect(weak.json()).toMatchObject({ code: 'passphrase_weak' });
    const mismatch = await createExport(ibrahim, {
      scope,
      includeSecrets: true,
      passphrase: PASS,
      passphraseAgain: `${PASS}!`,
    });
    expect(mismatch.statusCode).toBe(400);
    const stray = await createExport(bruce, { scope, passphrase: PASS });
    expect(stray.statusCode).toBe(400);
  });

  it('allows five an hour, and one running per location at a time', async () => {
    const scope = { locationId: home.id };
    const first = await createExport(bruce, { scope });
    expect(first.statusCode).toBe(202);
    const busy = await createExport(bruce, { scope });
    expect(busy.json()).toMatchObject({ code: 'export_running' });
    // Anyone's, though the run itself is invisible to another admin (D180; 0101's door).
    const theirs = await createExport(ibrahim, { scope });
    expect(theirs.json()).toMatchObject({ code: 'export_running' });
    await own(
      db,
      `UPDATE public.export_runs SET status = 'failed', error = 'test'
                    WHERE status IN ('queued', 'running')`,
    );
    for (let i = 0; i < 4; i++) {
      expect((await createExport(bruce, { scope })).statusCode).toBe(202);
      await own(
        db,
        `UPDATE public.export_runs SET status = 'failed', error = 'test'
                      WHERE status IN ('queued', 'running')`,
      );
    }
    const sixth = await createExport(bruce, { scope });
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('a location export', () => {
  // catalogue: POST /api/v1/exports
  it('holds every entity, every original and the readable copy, and no secret', async () => {
    const { id, outcome } = await exported(bruce, {
      scope: { locationId: home.id },
      options: { pdf: false },
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe('done');
    // The job's data names the run and nothing else.
    const job = sent.findLast((s) => s.name === 'export');
    expect(job?.data).toEqual({ exportId: id });

    const view = ok(
      await call(t, `/api/v1/exports/${id}`, { as: bruce }),
    ) as unknown as ExportRunView;
    expect(view).toMatchObject({ status: 'done', scope: 'location', includesSecrets: false });
    expect(view.fileUrl).toBeTruthy();
    expect(view.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Its creator's centre says it is ready.
    const notices = ok(
      await call(t, '/api/v1/notifications?kind=export_ready', { as: bruce }),
    ) as unknown as { items: { exportReady?: unknown }[] };
    expect(notices.items.map((n) => n.exportReady)).toContainEqual({ runId: id, kind: 'location' });
    const actions = (await auditOf(db, home.id)).map((e) => e.action);
    expect(actions).toContain('export.create');
    expect(actions).toContain('export.download');

    const zip = await zipOf(id);
    const manifest = ManifestSchema.parse(JSON.parse(text(zip, 'manifest.json'))) as ExportManifest;
    expect(manifest).toMatchObject({ format: 'kept-export', version: 1, exportId: id });
    expect(manifest.members.map((m) => m.role)).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(JSON.stringify(manifest.members)).not.toContain('@');
    for (const entity of EXPORTED_ENTITIES) {
      const name = `data/${entity}.ndjson`;
      expect(zip.has(name), name).toBe(true);
      expect(lines(zip, name)).toHaveLength(manifest.counts[entity]);
    }
    expect(Object.keys(manifest.counts).sort()).toEqual([...EXPORT_ENTITIES].sort());
    expect(manifest.counts.things).toBe(3);
    expect(manifest.counts.history).toBeGreaterThan(0);
    // Originals, byte-identical, by their own id.
    expect(manifest.files).toHaveLength(1);
    const [file] = manifest.files;
    expect(file?.path).toMatch(EXPORT_FILE_PATH);
    expect(sha256(zip.get(file?.path ?? '') as Buffer)).toBe(photoSha);
    expect(file?.sha256).toBe(photoSha);
    // No secret anywhere, and no secrets file.
    expect(zip.has('secrets.json')).toBe(false);
    for (const [name, bytes] of zip) expect(bytes.includes(SECRET), name).toBe(false);
    // The history says a secret changed, never what to.
    const secretEvents = lines(zip, 'data/history.ndjson').filter((e) =>
      JSON.stringify(e.diff ?? {}).includes('"secret"'),
    );
    expect(secretEvents.length).toBeGreaterThan(0);
    // The AI call ledger is there, even when empty.
    expect(text(zip, 'ai-calls.csv').startsWith('﻿')).toBe(true);
    // The readable copy links to the originals beside it.
    const index = text(zip, 'readable/index.html');
    expect(index).toContain(`../files/${file?.path.slice('files/'.length)}`);
    expect(index).not.toMatch(/<script/i);
    expect(index).not.toMatch(/(src|href)="https?:/i);
    expect(index).toContain('=HYPERLINK(&quot;http://evil&quot;)');
    expect(text(zip, 'readable/things.csv')).toContain(`"'=HYPERLINK(""http://evil"")"`);
    for (const [name] of zip) {
      if (name.startsWith('readable/')) expect(zip.get(name)?.includes(SECRET)).toBe(false);
    }
    expect([...zip.keys()].some((n) => /^readable\/thumbs\/[0-9a-f-]{36}\.jpg$/.test(n))).toBe(
      true,
    );
  });

  it('carries the secrets encrypted with the owner passphrase', async () => {
    const { id, outcome } = await exported(ibrahim, {
      scope: { locationId: home.id },
      includeSecrets: true,
      passphrase: PASS,
      passphraseAgain: PASS,
      options: { readable: false },
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe('done');
    const [row] = await own<{ c: unknown; v: number | null }>(
      db,
      'SELECT secrets_key_ciphertext AS c, key_version AS v FROM public.export_runs WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ c: null, v: null });
    const zip = await zipOf(id);
    for (const [name, bytes] of zip) expect(bytes.includes(SECRET), name).toBe(false);
    const file = checkSecretsFile(JSON.parse(text(zip, 'secrets.json')));
    const key = await keyForSecretsFile(PASS, file);
    const records = decryptSecrets(key, file, id)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ExportSecretRecord);
    expect(records).toEqual([
      expect.objectContaining({
        subject: { kind: 'thing', id: safe },
        fieldKey: 'combination',
        value: SECRET,
      }),
    ]);
    const wrong = await keyForSecretsFile('another passphrase entirely', file);
    expect(() => decryptSecrets(wrong, file, id)).toThrow(PassphraseWrongError);
    const manifest = JSON.parse(text(zip, 'manifest.json')) as ExportManifest;
    expect(manifest).toMatchObject({ includesSecrets: true, secretsCount: 1 });
    const audit = (await auditOf(db, home.id)).filter((e) => e.action === 'export.secrets');
    expect(audit.at(-1)?.diff).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('is gone for a creator who stops administering the location (D180)', async () => {
    const { id } = await exported(bruce, {
      scope: { locationId: home.id },
      options: { readable: false, history: false },
    });
    expect((await call(t, `/api/v1/exports/${id}`, { as: bruce })).statusCode).toBe(200);
    await own(
      db,
      `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
      [home.id, bruce.userId],
    );
    try {
      expect((await call(t, `/api/v1/exports/${id}`, { as: bruce })).statusCode).toBe(404);
      const list = ok(await call(t, '/api/v1/exports', { as: bruce })) as unknown as {
        items: ExportRunView[];
      };
      expect(list.items.map((r) => r.id)).not.toContain(id);
    } finally {
      await own(
        db,
        `UPDATE public.memberships SET role = 'admin' WHERE location_id = $1 AND user_id = $2`,
        [home.id, bruce.userId],
      );
    }
  });

  // catalogue: POST /api/v1/exports/:id/cancel
  it('cancels a queued export, and its job then makes nothing', async () => {
    const res = await createExport(ibrahim, {
      scope: { locationId: home.id },
      includeSecrets: true,
      passphrase: PASS,
      passphraseAgain: PASS,
    });
    const { id } = res.json() as ExportRunView;
    const cancelled = ok(
      await call(t, `/api/v1/exports/${id}/cancel`, { as: ibrahim, body: {} }),
    ) as unknown as ExportRunView;
    expect(cancelled.status).toBe('cancelled');
    const events = await auditOf(db, home.id);
    expect(events.map((e) => e.action)).toContain('export.cancel');
    const [row] = await own<{ c: unknown }>(
      db,
      'SELECT secrets_key_ciphertext AS c FROM public.export_runs WHERE id = $1',
      [id],
    );
    expect(row?.c).toBeNull();
    const outcome = await buildExport(
      deps(),
      { userId: ibrahim.userId, mfa: false },
      { exportId: id },
    );
    expect(outcome.status).toBe('skipped');
    expect(await files.blobs.exists(exportKey(id))).toBe(false);
  });

  it('runs as the worker does, from the job the request sent', async () => {
    const res = await createExport(bruce, {
      scope: { locationId: home.id },
      options: { readable: false, aiCalls: false },
    });
    const { id } = res.json() as ExportRunView;
    const job = exportJobs({ ...deps(), mailer: { send: async () => {} } }).find(
      (j) => j.name === 'export',
    );
    if (!job) throw new Error('no export job');
    const data = sent.findLast((s) => s.name === 'export')?.data;
    await runJob(job, { userId: bruce.userId, mfa: false, data }, db.pools);
    const view = ok(
      await call(t, `/api/v1/exports/${id}`, { as: bruce }),
    ) as unknown as ExportRunView;
    expect(view.status).toBe('done');
    expect(view.progress.done).toBe(view.progress.total);
  });
});

describe('export my data', () => {
  it('exports the Personal location with me.json', async () => {
    const { id, outcome } = await exported(louis, {
      scope: { me: true },
      options: { readable: false },
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe('done');
    const zip = await zipOf(id);
    const me = JSON.parse(text(zip, 'me.json')) as { profile: unknown };
    expect(me.profile).toBeTruthy();
    expect(text(zip, 'me.json')).not.toMatch(/token|session/i);
    expect(zip.has('my-ai-calls.csv')).toBe(true);
    const manifest = JSON.parse(text(zip, 'manifest.json')) as ExportManifest;
    expect(manifest).toMatchObject({ scope: 'me' });
    expect(manifest.location.id).toBe(louis.personalLocationId);
    const notices = ok(
      await call(t, '/api/v1/notifications?kind=export_ready', { as: louis }),
    ) as unknown as { items: { exportReady?: unknown }[] };
    expect(notices.items.map((n) => n.exportReady)).toContainEqual({ runId: id, kind: 'me' });
  });
});

describe('the readable copy', () => {
  it('reads right to left in Arabic, with Eastern digits when chosen', async () => {
    const { id } = await exported(ibrahim, {
      scope: { locationId: home.id },
      options: { locale: 'ar', digits: 'eastern', pdf: false, history: false },
    });
    const zip = await zipOf(id);
    const index = text(zip, 'readable/index.html');
    expect(index).toContain('<html lang="ar" dir="rtl">');
    expect(index).toContain('<bdi>غرفة المكتب</bdi>');
    expect(index).toMatch(/[٠-٩]/);
    expect(index).toContain('SN-TV-0001');
  });

  it('holds more than the report cap, says why there is no PDF, and lists every thing', async () => {
    const big = await createLocation(t, db, ibrahim, 'essentials', 'Warehouse');
    await own(
      db,
      `INSERT INTO public.things (location_id, place_id, name, created_by)
       SELECT $1, $2, 'Box ' || n, $3 FROM generate_series(1, 2001) n`,
      [big.id, big.unplacedId, ibrahim.userId],
    );
    const { id, outcome } = await exported(ibrahim, {
      scope: { locationId: big.id },
      options: { history: false, aiCalls: false },
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe('done');
    const zip = await zipOf(id);
    expect(zip.has('readable/inventory.pdf')).toBe(false);
    const manifest = JSON.parse(text(zip, 'manifest.json')) as ExportManifest;
    expect(manifest.readable.pdf).toBe('too_many_things');
    expect(text(zip, 'readable/index.html')).toContain('holds at most');
    // Over 500 in one place: that place has a page of its own.
    expect([...zip.keys()].some((n) => n.startsWith('readable/places/'))).toBe(true);
    const csv = text(zip, 'readable/things.csv').trim().split('\r\n');
    expect(csv).toHaveLength(2002);
  });

  it('includes the inventory PDF for a small location', async () => {
    const { id } = await exported(bruce, {
      scope: { locationId: home.id },
      options: { history: false, aiCalls: false },
    });
    const zip = await zipOf(id);
    expect(zip.get('readable/inventory.pdf')?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(text(zip, 'readable/index.html')).toContain('href="inventory.pdf"');
  });
});

describe('another tenant (step-7 definition of done 2)', () => {
  it("a byte search of Home's export, the ZIP and its readable copy, finds nothing of Alfred's household", async () => {
    // Alfred's household, with Ibrahim a member of it: the exporter can see it, so only the
    // export's own scoping keeps it out.
    const alfred = await person(t, db, 'alfred');
    await setDisplayName(db, alfred, 'Alfred-Pennyworth-6620');
    const family = await createLocation(t, db, alfred, 'complete', 'ALFRED-FAMILY-HOUSE-2207');
    await join(db, family.id, ibrahim.userId, 'member');
    const attic = await place(db, family, 'ALFRED-ATTIC-3312');
    const lamp = ok(
      await call(t, '/api/v1/things', {
        as: alfred,
        body: {
          locationId: family.id,
          placeId: attic,
          name: 'ALFRED-LAMP-7731',
          serial: 'SN-ALFRED-99881',
          notes: 'ALFRED-NOTE-5523',
          purchase: { purchasedOn: '2023-01-05', currency: 'EGP', price: '987654' },
        },
      }),
      201,
    ).id as string;
    const vault = (
      await createThing(t, alfred, family, {
        name: 'ALFRED-VAULT-4410',
        placeId: attic,
        typeId: await builtinType(db, 'safe'),
      })
    ).id as string;
    const put = await call(t, `/api/v1/things/${vault}/secrets/combination`, {
      as: alfred,
      method: 'PUT',
      body: { value: 'ALFRED-SECRET-8812' },
    });
    expect(put.statusCode, put.body).toBeLessThan(300);
    const photo = await uniqueJpeg();
    const up = await upload(t, alfred, family.id, photo);
    expect(up.statusCode, up.body).toBe(201);
    const fileId = up.json().id as string;
    ok(
      await call(t, '/api/v1/attachments', {
        as: alfred,
        body: { locationId: family.id, fileId, subject: { thingId: lamp }, role: 'photo' },
      }),
      201,
    );

    const { id, outcome } = await exported(ibrahim, {
      scope: { locationId: home.id },
      includeSecrets: true,
      passphrase: PASS,
      passphraseAgain: PASS,
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe('done');
    const chunks: Buffer[] = [];
    for await (const c of await files.blobs.stream(exportKey(id))) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const zip = await unzip(raw);
    expect([...zip.keys()].some((n) => n.startsWith('readable/'))).toBe(true);
    // The search can see: Home's own values are there, in the data and in the readable copy.
    const holds = (value: string, prefix: string) =>
      [...zip].some(([name, bytes]) => name.startsWith(prefix) && bytes.includes(value));
    expect(holds('SN-TV-0001', 'data/')).toBe(true);
    expect(holds('SN-TV-0001', 'readable/')).toBe(true);
    expect(holds(home.id, 'data/')).toBe(true);

    const theirs = [
      'ALFRED-FAMILY-HOUSE-2207',
      'ALFRED-ATTIC-3312',
      'ALFRED-LAMP-7731',
      'SN-ALFRED-99881',
      'ALFRED-NOTE-5523',
      '987654',
      'ALFRED-VAULT-4410',
      'ALFRED-SECRET-8812',
      'Alfred-Pennyworth-6620',
      family.id,
      family.unplacedId,
      attic,
      lamp,
      vault,
      fileId,
      alfred.userId,
      alfred.personalLocationId,
      sha256(photo),
    ];
    for (const value of theirs) {
      expect(raw.includes(value), `the ZIP holds ${value}`).toBe(false);
      for (const [name, bytes] of zip) {
        expect(name.includes(value), `an entry is named ${value}`).toBe(false);
        expect(bytes.includes(value), `${name} holds ${value}`).toBe(false);
      }
    }
    // Alfred's photo isn't there under any name.
    for (const [name, bytes] of zip) expect(bytes.equals(photo), name).toBe(false);
    // The secrets file, opened with the passphrase, holds Home's safe only.
    const file = checkSecretsFile(JSON.parse(text(zip, 'secrets.json')));
    const records = decryptSecrets(await keyForSecretsFile(PASS, file), file, id).toString('utf8');
    expect(records).toContain(safe);
    for (const value of theirs) expect(records.includes(value), value).toBe(false);
  });
});

describe('the purge', () => {
  it('sweeps an abandoned export scratch directory, not a fresh one', async () => {
    const old = path.join(files.tmpDir, 'export-AbC123');
    const fresh = path.join(files.tmpDir, 'export-XyZ789');
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const past = new Date(Date.now() - 4 * 3600 * 1000);
    await utimes(old, past, past);
    expect(await sweepExportScratch(files)).toBe(1);
    expect(await sweepExportScratch(files)).toBe(0);
  });
});

describe('over plain http (D181, step-8 T24)', () => {
  it('refuses to start an export: 403 https_required, and no run is made', async () => {
    const plain = await peopleApp(db, { files });
    try {
      const who = await person(plain, db, 'plain');
      const res = await call(plain, '/api/v1/exports', {
        as: who,
        body: { scope: { locationId: who.personalLocationId } },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'https_required' });
      const runs = await own(db, 'SELECT 1 FROM public.export_runs WHERE created_by = $1', [
        who.userId,
      ]);
      expect(runs).toHaveLength(0);
    } finally {
      await plain.app.close();
    }
  });
});
