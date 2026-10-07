import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXPORT_ENTITIES,
  EXPORT_FORMAT,
  EXPORT_PATHS,
  EXPORT_VERSION,
  type ExportEntity,
  type ExportManifest,
  type ExportOptions,
  type ExportPdfOutcome,
  KEPT_VERSION,
} from '@kept/shared';
import type pg from 'pg';
import { whoAmI } from '../ai/api-kit.js';
import { CallsQuery, callsCsv } from '../ai/calls.js';
import { audited } from '../audit/audited.js';
import type { Sealed } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope, withSystem } from '../db/scope.js';
import { downloadName } from '../files/views.js';
import { pgErrorOf } from '../http/errors.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { encryptSecrets, openRunKey } from '../portability/passphrase.js';
import { writeArchive } from '../portability/zip/write.js';
import type { RenderOptions } from '../reports/render/render.js';
import { gateFor } from '../serialize/gates.js';
import { exportKey, type FileStorage } from '../storage/blob-store.js';
import { type ReadContext, readEntity } from './data.js';
import { historyViewer, readHistory } from './history.js';
import { buildReadableCopy } from './readable/index.js';
import { EXPORTED_ENTITIES, entityDef, HISTORY_ENTITY } from './registry.js';
import { readSecrets } from './secrets.js';
import { type ExportJobData, optionsOf } from './service.js';

// The `export` job (D68, D69, D159, D180; step-7 plan T12): one Kept export ZIP, built in its
// creator's scope (the tenant job's, taken from the sending transaction; `data` names only the
// run, never a passphrase or a key, Q7). One attempt, 2 hours (jobs/policies.ts).
//
// 1. Claims the run (kept.export_run_claim: queued → running). Anything else, or a creator who no
//    longer owns or administers the location (D180), is skipped.
// 2. Writes each entity to `KEPT_DATA_DIR/tmp/export-…/data/<entity>.ndjson`, read in keyset
//    pages under row-level security (exports/data.ts), then the history, the AI call ledger,
//    the secrets (encrypted with the passphrase's key, which the job opens from the run and the
//    finishing door clears), "Export my data"'s me.json, and the readable copy (T13).
// 3. Checks the free space (`statfs`: the originals' size × 1.1, else `no_space`), streams the
//    whole into one ZIP (portability/zip/write.ts), puts it at `x/<id>.zip`, and finishes the run
//    with its size and SHA-256 (seven days from now, §3.3).
//
// Progress: a step per entity file, per 100 originals and per later stage. Cancel: the creator's
// POST …/cancel finishes the run `cancelled`; the job sees it at its next check (each entity, each
// stage, each progress write) and stops, leaving nothing behind. Expired exports go with step 4's
// hourly `purge-exports` (incidents/jobs.ts), extended by exports/purge.ts.

const PROGRESS_FILES = 100;
const SPACE_MARGIN = 1.1;
const SPACE_FLOOR = 64 * 1024 * 1024;

export type ExportJobDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage | null;
  secretKeys: SecretKeys | null;
  publicUrl: string;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  render?: RenderOptions;
  now?: () => Date;
};

export type ExportOutcome =
  | { status: 'done'; bytes: number; sha256: string; files: number }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }
  | { status: 'skipped' };

/** The run was cancelled (or lost to its creator) while it was built. */
class Stopped extends Error {
  constructor() {
    super('export stopped');
    this.name = 'Stopped';
  }
}

class ExportFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExportFailure';
  }
}

type Claimed = { location_id: string; kind: string; include_secrets: boolean };

type RunInfo = {
  options: Partial<ExportOptions>;
  secrets_key_ciphertext: Sealed | null;
  name: string;
  kind: string;
  timezone: string;
  currency: string;
  languages: string[] | null;
  owner_account_id: string;
  display_name: string | null;
};

type FileRef = {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
  key: string;
};

/** NDJSON written a line at a time, waiting for the disk when it asks to. */
class Lines {
  private readonly out: WriteStream;
  count = 0;
  constructor(file: string) {
    this.out = createWriteStream(file, { mode: 0o600 });
  }
  async write(value: unknown): Promise<void> {
    this.count += 1;
    if (!this.out.write(`${JSON.stringify(value)}\n`)) await once(this.out, 'drain');
  }
  async close(): Promise<void> {
    this.out.end();
    await once(this.out, 'finish');
  }
}

const isPermission = (err: unknown) => pgErrorOf(err)?.code === '42501';

async function finish(
  deps: ExportJobDeps,
  scope: Scope,
  id: string,
  outcome: { bytes: number; sha256: string } | { error: string },
): Promise<boolean> {
  try {
    await withScope(deps.pools.app, scope, (_tx, c) =>
      c.query('SELECT kept.export_run_finish($1, $2, $3, $4, $5)', [
        id,
        'bytes' in outcome ? outcome.bytes : null,
        'bytes' in outcome ? 'done' : 'failed',
        'error' in outcome ? outcome.error : null,
        'sha256' in outcome ? outcome.sha256 : null,
      ]),
    );
    return true;
  } catch (err) {
    if (isPermission(err)) return false;
    throw err;
  }
}

/**
 * One run of the `export` job, in `scope` (its creator's). Returns what happened; throws only for
 * an unexpected error, after failing the run `internal`.
 */
export async function buildExport(
  deps: ExportJobDeps,
  scope: Scope,
  data: ExportJobData,
): Promise<ExportOutcome> {
  const now = deps.now ?? (() => new Date());
  const id = data.exportId.toLowerCase();
  const inScope = <T>(fn: (tx: Tx, c: pg.PoolClient) => Promise<T>) =>
    withScope(deps.pools.app, scope, fn);

  let claimed: Claimed | null;
  try {
    claimed = await inScope(async (_tx, c) => {
      const { rows } = await c.query<Claimed>(
        'SELECT location_id, kind, include_secrets FROM kept.export_run_claim($1)',
        [id],
      );
      return rows[0] ?? null;
    });
  } catch (err) {
    if (isPermission(err)) return { status: 'skipped' };
    throw err;
  }
  if (!claimed) return { status: 'skipped' };
  if (claimed.kind !== 'location' && claimed.kind !== 'me') {
    await finish(deps, scope, id, { error: 'wrong_kind' });
    return { status: 'skipped' };
  }
  const kind = claimed.kind;
  const files = deps.files;
  if (!files) {
    await finish(deps, scope, id, { error: 'no_storage' });
    return { status: 'failed', error: 'no_storage' };
  }
  const locationId = claimed.location_id;

  let dir: string | null = null;
  let total = 0;
  let done = 0;
  const progress = async (step = 1) => {
    done += step;
    try {
      await inScope((_tx, c) =>
        c.query('SELECT kept.export_run_progress($1, $2, $3)', [id, Math.min(done, total), total]),
      );
    } catch (err) {
      if (isPermission(err)) throw new Stopped();
      throw err;
    }
  };
  const checkpoint = async () => {
    const status = await inScope(async (_tx, c) => {
      const { rows } = await c.query<{ status: string }>(
        'SELECT status FROM public.export_runs WHERE id = $1',
        [id],
      );
      return rows[0]?.status ?? null;
    });
    if (status !== 'running') throw new Stopped();
  };

  try {
    const run = await inScope(async (_tx, c) => {
      const { rows } = await c.query<RunInfo>(
        `SELECT x.options, x.secrets_key_ciphertext, l.name, l.kind, l.timezone, l.currency,
                l.languages, l.owner_account_id, p.display_name
           FROM public.export_runs x
           JOIN public.locations l ON l.id = x.location_id
           LEFT JOIN public.user_profiles p ON p.user_id = kept.current_user_id()
          WHERE x.id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
    if (!run) throw new Stopped();
    const options = optionsOf(run.options);
    const showMoney = await inScope(async (tx) => (await gateFor(tx, locationId, scope)).showMoney);
    const ctx: ReadContext = {
      locationId,
      accountId: run.owner_account_id,
      showMoney,
      ended: options.ended,
      trashed: options.trashed,
    };
    const entities = EXPORTED_ENTITIES.filter((e) => e !== HISTORY_ENTITY);
    total = entities.length + 1 + (options.history ? 1 : 0) + (options.readable ? 1 : 0);

    await mkdir(files.tmpDir, { recursive: true });
    dir = await mkdtemp(path.join(files.tmpDir, 'export-'));
    const work = dir;
    await mkdir(path.join(work, 'data'));
    await progress(0);

    // 1. The data files.
    const counts = Object.fromEntries(EXPORT_ENTITIES.map((e) => [e, 0])) as Record<
      ExportEntity,
      number
    >;
    const fileRows: { id: string; sha256: string; bytes: number; mime: string }[] = [];
    let modules: string[] = [];
    for (const entity of entities) {
      await checkpoint();
      const def = entityDef(entity);
      if (!def) continue;
      const out = new Lines(path.join(work, EXPORT_PATHS.data(entity)));
      try {
        await inScope(async (_tx, c) => {
          for await (const row of readEntity(c, def, ctx)) {
            await out.write(row);
            if (entity === 'files') {
              fileRows.push({
                id: String(row.id),
                sha256: String(row.sha256).trim(),
                bytes: Number(row.bytes),
                mime: String(row.mime),
              });
            }
            if (entity === 'location') modules = (row.modules as string[] | undefined) ?? [];
          }
        });
      } finally {
        await out.close();
      }
      counts[entity] = out.count;
      await progress();
    }

    // 2. The history (§3.3), rendered for the creator (D110).
    if (options.history) {
      await checkpoint();
      const out = new Lines(path.join(work, EXPORT_PATHS.data(HISTORY_ENTITY)));
      try {
        await inScope(async (tx, c) => {
          const viewer = await historyViewer(tx, c, scope, locationId);
          for await (const event of readHistory(c, locationId, viewer)) await out.write(event);
        });
      } finally {
        await out.close();
      }
      counts.history = out.count;
      await progress();
    }

    // 3. The AI call ledger (§7.15), and for "Export my data" the person's own.
    const extras: { name: string; file: string }[] = [];
    if (options.aiCalls) {
      await checkpoint();
      const write = async (name: string, q: Record<string, unknown>) => {
        const csv = await inScope(async (tx, c) => {
          const who = await whoAmI(c);
          return (
            await callsCsv({ tx, client: c, scope, who, tz: run.timezone }, CallsQuery.parse(q))
          ).csv;
        });
        const file = path.join(work, name);
        await writeFile(file, csv, { mode: 0o600 });
        extras.push({ name, file });
      };
      await write(EXPORT_PATHS.aiCalls, { scope: 'location', locationId });
      if (kind === 'me') await write(EXPORT_PATHS.myAiCalls, { scope: 'me' });
    }

    // 4. The secrets, encrypted with the passphrase's key (D68).
    let secretsCount = 0;
    if (claimed.include_secrets) {
      await checkpoint();
      const keys = deps.secretKeys;
      if (!keys || !run.secrets_key_ciphertext) throw new ExportFailure('no_key');
      const opened = await openRunKey(keys, 'export_runs', id, run.secrets_key_ciphertext);
      try {
        if (!opened.salt || !opened.kdf) throw new ExportFailure('no_key');
        const lines: string[] = [];
        await inScope(async (tx, c) => {
          for await (const record of readSecrets(c, keys, ctx)) lines.push(JSON.stringify(record));
          secretsCount = lines.length;
          await audited(tx, {
            locationId,
            actor: { type: 'user', id: scope.userId },
            action: 'export.secrets',
            entity: { type: 'export_run', id },
            before: null,
            after: { count: secretsCount },
          });
        });
        const plain = Buffer.from(lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
        lines.length = 0;
        const file = encryptSecrets(opened.key, { salt: opened.salt, kdf: opened.kdf }, id, plain);
        plain.fill(0);
        const at = path.join(work, EXPORT_PATHS.secrets);
        await writeFile(at, `${JSON.stringify(file)}\n`, { mode: 0o600 });
        extras.push({ name: EXPORT_PATHS.secrets, file: at });
      } finally {
        opened.key.fill(0);
      }
    }

    // 5. "Export my data" (Q14): the person's own settings, never a token or a session.
    if (kind === 'me') {
      await checkpoint();
      const me = await inScope((_tx, c) => readMe(c));
      const at = path.join(work, EXPORT_PATHS.me);
      await writeFile(at, `${JSON.stringify(me, null, 2)}\n`, { mode: 0o600 });
      extras.push({ name: EXPORT_PATHS.me, file: at });
    }

    // 6. The readable copy (T13), linking to the originals beside it.
    let readable: { included: boolean; pdf: ExportPdfOutcome; written: string[] } = {
      included: false,
      pdf: 'off',
      written: [],
    };
    if (options.readable) {
      await checkpoint();
      const result = await buildReadableCopy(
        {
          pools: deps.pools,
          files,
          publicUrl: deps.publicUrl,
          log: deps.log,
          ...(deps.render ? { render: deps.render } : {}),
          now,
        },
        scope,
        locationId,
        { dir: path.join(work, EXPORT_PATHS.readableDir), filesHref: '../files' },
        {
          locale: options.locale,
          digits: options.digits,
          ended: options.ended,
          trashed: options.trashed,
          pdf: options.pdf,
        },
        { checkpoint },
      );
      readable = { included: true, pdf: result.pdf, written: result.written };
      await progress();
    }

    // 7. The originals: where they are, and room for them.
    await checkpoint();
    const refs = await inScope((_tx, c) => fileRefs(c, locationId, fileRows));
    const needed = refs.reduce((n, f) => n + f.bytes, 0);
    const space = await statfs(files.tmpDir);
    if (space.bavail * space.bsize < Math.max(needed * SPACE_MARGIN, SPACE_FLOOR)) {
      throw new ExportFailure('no_space');
    }
    total += Math.ceil(refs.length / PROGRESS_FILES);

    const members = await inScope(async (_tx, c) => {
      const { rows } = await c.query<{ name: string | null; role: string }>(
        `SELECT p.display_name AS name, m.role FROM public.memberships m
           LEFT JOIN public.user_profiles p ON p.user_id = m.user_id
          WHERE m.location_id = $1 AND (m.expires_at IS NULL OR m.expires_at > now())
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2
                   ELSE 3 END, lower(p.display_name), m.id`,
        [locationId],
      );
      return rows.map((r) => ({ name: r.name ?? '', role: r.role }));
    });

    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      keptVersion: KEPT_VERSION,
      exportId: id,
      createdAt: now().toISOString(),
      createdBy: { displayName: run.display_name ?? '' },
      scope: kind,
      location: {
        id: locationId,
        name: run.name,
        kind: run.kind,
        timezone: run.timezone,
        currency: run.currency,
        languages: run.languages ?? [],
        modules,
      },
      options,
      counts,
      moneyHidden: !showMoney,
      includesSecrets: claimed.include_secrets,
      secretsCount,
      members,
      files: refs.map(({ key: _key, ...f }) => f),
      readable: { included: readable.included, pdf: readable.pdf },
    };

    // 8. The ZIP.
    await checkpoint();
    const zipPath = path.join(work, 'export.zip');
    let packed = 0;
    let stopped = false;
    const written = await writeArchive(zipPath, (zip) => {
      zip.addBuffer(EXPORT_PATHS.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
      for (const entity of EXPORTED_ENTITIES) {
        if (entity === HISTORY_ENTITY && !options.history) continue;
        const name = EXPORT_PATHS.data(entity);
        zip.addStream(name, () => createReadStream(path.join(work, name)));
      }
      for (const extra of extras) zip.addStream(extra.name, () => createReadStream(extra.file));
      for (const rel of readable.written) {
        zip.addStream(`${EXPORT_PATHS.readableDir}/${rel}`, () =>
          createReadStream(path.join(work, EXPORT_PATHS.readableDir, rel)),
        );
      }
      for (const f of refs) {
        zip.addStream(
          f.path,
          async () => {
            if (stopped) throw new Stopped();
            packed += 1;
            if (packed % PROGRESS_FILES === 0) {
              await progress().catch((err: unknown) => {
                stopped = true;
                throw err;
              });
            }
            return files.blobs.stream(f.key);
          },
          { contentType: f.mime, size: f.bytes },
        );
      }
    });
    await checkpoint();

    // 9. Stored, and finished.
    const key = exportKey(id);
    await files.blobs.put(key, zipPath, { contentType: 'application/zip', bytes: written.bytes });
    if (!(await finish(deps, scope, id, { bytes: written.bytes, sha256: written.sha256 }))) {
      // Cancelled, purged, or its creator lost the role meanwhile: nothing may serve it.
      await files.blobs.delete(key);
      return { status: 'cancelled' };
    }
    // Its creator's centre says it is ready (`export_ready`, the run's own kind), as a claim
    // pack's does; a notice that can't be written costs the run nothing.
    await withSystem(deps.pools.system, (_tx, c) =>
      c.query(
        `INSERT INTO public.notifications (user_id, location_id, kind, payload)
         VALUES ($1, $2, 'export_ready', $3::jsonb)`,
        [scope.userId, locationId, JSON.stringify({ runId: id, kind })],
      ),
    ).catch((err: unknown) => deps.log.error({ err, exportId: id }, 'export: notice not written'));
    deps.log.info({ exportId: id, files: refs.length, bytes: written.bytes }, 'export built');
    return { status: 'done', bytes: written.bytes, sha256: written.sha256, files: refs.length };
  } catch (err) {
    if (err instanceof Stopped) {
      // Cancelled (the door already finished it) or no longer its creator's: fail it if it is
      // somehow still running, and leave nothing behind.
      await finish(deps, scope, id, { error: 'stopped' }).catch(() => false);
      return { status: 'cancelled' };
    }
    const code = err instanceof ExportFailure ? err.code : 'internal';
    await finish(deps, scope, id, { error: code }).catch(() => false);
    if (code !== 'internal') return { status: 'failed', error: code };
    throw err;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** The originals of the exported `files` rows: their blob keys and archive paths. */
async function fileRefs(
  client: pg.ClientBase,
  locationId: string,
  rows: readonly { id: string; sha256: string; bytes: number; mime: string }[],
): Promise<FileRef[]> {
  const keys = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 1000) {
    const ids = rows.slice(i, i + 1000).map((r) => r.id);
    const { rows: found } = await client.query<{ id: string; storage_key: string }>(
      'SELECT id, storage_key FROM public.files WHERE location_id = $1 AND id = ANY ($2::uuid[])',
      [locationId, ids],
    );
    for (const f of found) keys.set(f.id, f.storage_key);
  }
  return rows.flatMap((r) => {
    const key = keys.get(r.id);
    if (!key) return [];
    const ext = downloadName(r.id, r.mime, 'original').split('.').pop() ?? 'bin';
    return [{ ...r, key, path: EXPORT_PATHS.file(r.id, ext) }];
  });
}

/** `me.json` (Q14): the person's profile, preferences, hints and saved views. */
async function readMe(client: pg.ClientBase): Promise<Record<string, unknown>> {
  const all = async (sql: string) => (await client.query(sql)).rows;
  const [profile] = await all(
    `SELECT display_name AS "displayName", timezone, locale, units, theme, digits,
            suggest_location AS "suggestLocation", digest_time::text AS "digestTime",
            quiet_from::text AS "quietFrom", quiet_to::text AS "quietTo"
       FROM public.user_profiles WHERE user_id = kept.current_user_id()`,
  );
  return {
    format: 'kept-me',
    version: 1,
    profile: profile ?? null,
    notificationPreferences: await all(
      `SELECT location_id AS "locationId", kind, channel, enabled
         FROM public.notification_preferences WHERE user_id = kept.current_user_id()
        ORDER BY location_id NULLS FIRST, kind, channel`,
    ),
    hints: await all(
      `SELECT hint_key AS "hintKey", seen_at AS "seenAt", dismissed
         FROM public.user_hints WHERE user_id = kept.current_user_id() ORDER BY hint_key`,
    ),
    hiddenModules: await all(
      `SELECT location_id AS "locationId", module FROM public.user_hidden_modules
        WHERE user_id = kept.current_user_id() ORDER BY location_id, module`,
    ),
    savedViews: await all(
      `SELECT id, location_id AS "locationId", surface, name, query, shared,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM public.saved_views WHERE user_id = kept.current_user_id() ORDER BY created_at, id`,
    ),
    savedViewPrefs: await all(
      `SELECT surface, default_view_id AS "defaultViewId", pinned
         FROM public.saved_view_prefs WHERE user_id = kept.current_user_id() ORDER BY surface`,
    ),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `data` as the route sent it, or null. */
export function exportJobData(data: unknown): ExportJobData | null {
  const id = (data as { exportId?: unknown } | null)?.exportId;
  return typeof id === 'string' && UUID.test(id) ? { exportId: id } : null;
}

export function exportJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'export',
      kind: 'tenant',
      policy: JOB_POLICIES.export,
      handler: async ({ data, scope, client }) => {
        const parsed = exportJobData(data);
        if (!parsed) throw new Error('export job: data names no run');
        const app = deps.pools.app;
        if (!app) throw new Error('export job: the worker has no kept_app pool');
        // As the claim pack: runJob() holds this scoped transaction open while the export's own
        // steps commit on their own connections.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '7200s'`);
        await buildExport(
          {
            pools: { app, system: deps.pools.system },
            files: deps.files ?? null,
            secretKeys: deps.secretKeys ?? null,
            publicUrl: deps.publicUrl,
            log: deps.log,
          },
          scope,
          parsed,
        );
      },
    }),
  ];
}
