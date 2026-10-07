import {
  BACKUP_PASSWORD_MAX,
  BACKUP_PASSWORD_MIN,
  BACKUP_RUN_KINDS,
  BACKUP_RUN_STATES,
  type BackupRun,
  type BackupRunKind,
  BackupSettingsInput,
  type BackupSettingsView,
  type BackupSnapshot,
  BackupTestInput,
  type BackupTestResult,
  newId,
  RESTIC_ERROR_REASONS,
} from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import { backupCron } from '../backup/config.js';
import { type Restic, ResticError, type ResticRepo } from '../backup/restic/restic.js';
import {
  BACKUP_RUN_COLUMNS,
  type BackupRunRow,
  backupQueued,
  backupRunning,
  backupRunOf,
} from '../backup/runs.js';
import {
  applyBackupSettings,
  backupEnvOverlay,
  backupSettingsView,
  backupTimeEffective,
  describeBackupTarget,
  isResolved,
  type RawEnv,
  type ResolvedBackupSettings,
  readStoredBackupSettings,
  resolveBackupSettings,
  writeStoredBackupSettings,
} from '../backup/settings.js';
import { type Tx, withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { checkVersion, decodeCursor, encodeCursor, requireIfMatch } from '../http/conventions.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import { requireHttps } from '../http/https-only.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { markRecoveryKitStale, requireRecoveryKitAck } from '../setup/recovery-kit.js';

// Step 8: Admin → Backups (D64, D66, D144, D186, D193; plan T10). Instance admins only
// (kept.is_instance_admin(), 404 for anyone else: the screen doesn't exist for them); the
// settings' PUT and the restic test behind requireHttps() (D181), audited with the target kind
// and `{changed: true}` per secret, never a value. The PUT and the test run on withScope()
// directly, not scopedWrite(): their bodies carry secrets, and the Idempotency-Key store would
// keep a hash of them (as the secret values' routes avoid).
//
// GET  /api/v1/admin/backup            → BackupSettingsView (+ `version` for If-Match)
// PUT  /api/v1/admin/backup            BackupSettingsInput + If-Match → BackupSettingsView;
//                                      409 recovery_kit_required, 400 setting_locked,
//                                      400 backup_password_weak
// POST /api/v1/admin/backup/test       BackupTestInput → BackupTestResult
// POST /api/v1/admin/backup/run        → 202 BackupRun; 409 backup_running,
//                                      409 backup_not_configured
// GET  /api/v1/admin/backup/runs?kind&status&q&cursor → BackupRunsPage
// GET  /api/v1/admin/backup/snapshots  → BackupSnapshotsPage (restic snapshots, cached 5 min)
//
// "Run now" sends the `backup` system job with `{kind: 'manual', runId}`; the worker's backup
// (backup/nightly.ts) records its run under that id, so the 202's row is the one the list shows
// next. The 202 body is that row as it starts (`running`), not read back: backup_runs is written
// only by kept_owner. Shapes: @kept/shared ops.ts.

/** How restic is reached from a request: the process's engine (main.ts), or a test's fake. */
export type BackupEngine = {
  restic: Restic;
  /** The repository the settings name (T5's restic/repo.ts openRepo), and its cleanup. */
  open: (
    settings: ResolvedBackupSettings,
  ) => Promise<{ repo: ResticRepo; dispose(): Promise<void> }>;
};

let engine: BackupEngine | null = null;
let rawEnv: RawEnv = process.env;

const SNAPSHOT_CACHE_MS = 5 * 60_000;
const snapshotCache = new Map<string, { items: BackupSnapshot[]; cachedAt: Date }>();

/**
 * Sets the engine the test and snapshot routes use (main.ts at boot; tests, a FakeRestic) and,
 * for tests, the raw environment the settings' locks come from (default process.env, which
 * loadEnv() validated: whether the operator set KEPT_BACKUP_TIME is only known there).
 */
export function configureBackupRoutes(opts: { engine?: BackupEngine | null; env?: RawEnv }): void {
  if (opts.engine !== undefined) engine = opts.engine;
  if (opts.env !== undefined) rawEnv = opts.env;
  snapshotCache.clear();
}

const notConfigured = () =>
  new AppError('backup_not_configured', 409, 'Choose where backups go and set their password.');
const noEngine = () =>
  new AppError('restic_failed', 503, 'The backup tool is not available in this process.', {
    reason: 'failed',
  });

async function isInstanceAdmin(deps: InventoryDeps, req: FastifyRequest) {
  return withScope(deps.pools.app, requireScope(req), async (_tx, client) => {
    const { rows } = await client.query<{ admin: boolean }>(
      'SELECT kept.is_instance_admin() AS admin',
    );
    return rows[0]?.admin === true;
  });
}

function auditInstance(
  tx: Tx,
  req: FastifyRequest,
  action: string,
  after: Record<string, unknown>,
) {
  return audited(tx, {
    locationId: null,
    ownerAccountId: null,
    actor: { type: 'user', id: requireScope(req).userId },
    action,
    entity: { type: 'instance_settings', id: null },
    after,
    requestId: req.id,
  });
}

/** The PUT's body: the shared schema, with the password's minimum checked by the handler so a
 * short one is `backup_password_weak`, not a generic validation error. */
const PutBody = BackupSettingsInput.extend({
  password: z.string().min(1).max(BACKUP_PASSWORD_MAX).optional(),
});

const RunsQuery = z.object({
  kind: z.enum(BACKUP_RUN_KINDS).optional(),
  status: z.enum(BACKUP_RUN_STATES).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().max(2048).optional(),
});

function snapshotOf(s: { id: string; time: Date; tags: string[] }): BackupSnapshot {
  const kind = BACKUP_RUN_KINDS.find((k) => s.tags.includes(k)) ?? null;
  const version = s.tags.find((t) => /^v\d+\.\d+\.\d+/.test(t))?.slice(1) ?? null;
  return {
    id: s.id,
    time: s.time.toISOString(),
    kind: kind as BackupRunKind | null,
    version,
    tags: [...s.tags],
  };
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function backupRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const httpsOnly = requireHttps(deps.env.KEPT_PUBLIC_URL);

  /** The settings with their secrets opened (the keyring), or 409 backup_not_configured. */
  async function resolved(client: pg.ClientBase) {
    const { stored, version } = await readStoredBackupSettings(client);
    const keys = deps.secretKeys?.get() ?? null;
    const r = resolveBackupSettings(stored, backupEnvOverlay(rawEnv), keys?.keyring ?? null);
    if (!isResolved(r)) throw notConfigured();
    return { settings: r, version };
  }

  async function withRepo<T>(
    settings: ResolvedBackupSettings,
    fn: (restic: Restic, repo: ResticRepo) => Promise<T>,
  ): Promise<T> {
    if (!engine) throw noEngine();
    const opened = await engine.open(settings);
    try {
      return await fn(engine.restic, opened.repo);
    } finally {
      await opened.dispose();
    }
  }

  await app.register(async (scope) => {
    const admin = scope.withTypeProvider<ZodTypeProvider>();
    admin.addHook('preHandler', async (req) => {
      if (!(await isInstanceAdmin(deps, req))) throw notFound();
    });

    admin.get('/api/v1/admin/backup', async (req): Promise<BackupSettingsView> => {
      const { stored, version } = await scopedRead(pools, req, (_tx, client) =>
        readStoredBackupSettings(client),
      );
      return backupSettingsView(stored, version, backupEnvOverlay(rawEnv));
    });

    admin.put(
      '/api/v1/admin/backup',
      { preHandler: httpsOnly, schema: { body: PutBody } },
      async (req): Promise<BackupSettingsView> => {
        const expected = requireIfMatch(req);
        const { password } = req.body;
        if (password !== undefined && [...password].length < BACKUP_PASSWORD_MIN) {
          throw new AppError(
            'backup_password_weak',
            400,
            `Use at least ${BACKUP_PASSWORD_MIN} characters; a passphrase of a few words is easiest.`,
          );
        }
        const input = BackupSettingsInput.safeParse(req.body);
        if (!input.success) throw invalid();
        const keys = deps.secretKeys?.get();
        if (!keys) throw new AppError('internal', 503, 'The keyring is not loaded.');
        // D193: a backup holds what every secret's key opens; the kit comes first.
        await requireRecoveryKitAck(pools.system);
        const overlay = backupEnvOverlay(rawEnv);
        const saved = await withScope(pools.app, requireScope(req), async (tx, client) => {
          const { stored, version } = await readStoredBackupSettings(client);
          checkVersion({ rowVersion: version }, expected, ['target', 'password', 'time', 'keep']);
          const { next, audit } = applyBackupSettings(stored, input.data, overlay, keys.current);
          const nextVersion = await writeStoredBackupSettings(client, next);
          // The kit holds the repository, its password and credentials (T9): a kit downloaded
          // before this change is stale.
          if (Object.keys(audit.changed).length > 0) await markRecoveryKitStale(client);
          await auditInstance(tx, req, 'instance.backup_settings', {
            targetKind: audit.targetKind,
            changed: audit.changed,
          });
          snapshotCache.clear();
          return { next, nextVersion, timeChanged: audit.changed.time === true };
        });
        // A new time moves the nightly schedule now, not at the worker's next start (pg-boss
        // keeps schedules in its tables; the worker's cron reads them). After the commit: a
        // failure leaves the saved time for the worker's start (jobs/system.ts) to pick up.
        if (saved.timeChanged && deps.jobs?.reschedule) {
          const time = backupTimeEffective(saved.next, overlay);
          await deps.jobs.reschedule('backup', backupCron(time)).catch((err: unknown) => {
            req.log.warn({ err, time }, 'backup: the nightly schedule was not moved');
          });
        }
        return backupSettingsView(saved.next, saved.nextVersion, overlay);
      },
    );

    admin.post(
      '/api/v1/admin/backup/test',
      { preHandler: httpsOnly, schema: { body: BackupTestInput.optional() } },
      async (req): Promise<BackupTestResult> => {
        const init = req.body?.init === true;
        const { settings } = await scopedRead(pools, req, (_tx, client) => resolved(client));
        const result = await withRepo(settings, async (restic, repo): Promise<BackupTestResult> => {
          try {
            await restic.snapshots(repo);
            return { ok: true, initialised: true };
          } catch (err) {
            if (!(err instanceof ResticError)) throw err;
            if (err.reason !== 'no_repository' || !init) {
              return { ok: false, initialised: false, error: err.reason };
            }
          }
          try {
            await restic.init(repo);
            return { ok: true, initialised: true };
          } catch (err) {
            if (!(err instanceof ResticError)) throw err;
            return { ok: false, initialised: false, error: err.reason };
          }
        });
        await withScope(pools.app, requireScope(req), (tx) =>
          auditInstance(tx, req, 'instance.backup_test', {
            ok: result.ok,
            init,
            error: result.error ?? null,
          }),
        );
        if (result.ok) snapshotCache.clear();
        return result;
      },
    );

    admin.post('/api/v1/admin/backup/run', async (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const overlay = backupEnvOverlay(rawEnv);
        const { stored } = await readStoredBackupSettings(client);
        if (!backupSettingsView(stored, 0, overlay).configured) throw notConfigured();
        // One press at a time: a second "Run now" waits for this one's commit, then sees its
        // job queued (pg-boss) before the worker has written the run's row.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['kept:backup-run-now']);
        if ((await backupRunning(client)) || (await backupQueued(pools.system))) {
          throw new AppError('backup_running', 409, 'Wait for the running backup to finish.');
        }
        const runId = newId();
        const target = overlay.target ?? stored.target ?? null;
        const run: BackupRun = {
          id: runId,
          kind: 'manual',
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          storageMode: overlay.storageMode,
          target: target ? describeBackupTarget(target) : 'backup',
          snapshotId: null,
          dbBytes: null,
          bytesAdded: null,
          bytesTotal: null,
          filesTotal: null,
          filesNew: null,
          missing: 0,
          readableLocations: null,
          readableBytes: null,
          sameVolume: null,
          bucketVersioningOk: null,
          fromVersion: null,
          toVersion: null,
          verifiedAt: null,
          error: null,
          detail: {},
        };
        if (deps.jobs) await deps.jobs.send(client, 'backup', { kind: 'manual', runId });
        else deps.log.warn({ job: 'backup' }, 'no job queue: the manual backup was not sent');
        await auditInstance(tx, req, 'instance.backup_run', { runId, kind: 'manual' });
        return { status: 202, body: run };
      }),
    );

    admin.get('/api/v1/admin/backup/runs', { schema: { querystring: RunsQuery } }, async (req) => {
      const { kind, status, q, limit, cursor } = req.query;
      const after = cursor ? decodeCursor<[string, string]>(cursor) : null;
      if (after && (!Array.isArray(after) || after.length !== 2)) throw invalid();
      const rows = await scopedRead(pools, req, async (_tx, client) => {
        const res = await client.query<BackupRunRow>(
          `SELECT ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
            WHERE ($1::text IS NULL OR kind = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::text IS NULL OR error ILIKE $3 OR target ILIKE $3)
              AND ($4::timestamptz IS NULL OR (started_at, id) < ($4::timestamptz, $5::uuid))
            ORDER BY started_at DESC, id DESC
            LIMIT $6`,
          [
            kind ?? null,
            status ?? null,
            q ? `%${escapeLike(q)}%` : null,
            after?.[0] ?? null,
            after?.[1] ?? null,
            limit + 1,
          ],
        );
        return res.rows;
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(backupRunOf),
        next_cursor:
          rows.length > limit && last
            ? encodeCursor([last.started_at.toISOString(), last.id])
            : null,
      };
    });

    admin.get('/api/v1/admin/backup/snapshots', async (req) => {
      const { settings, version } = await scopedRead(pools, req, (_tx, client) => resolved(client));
      const key = `${version}|${settings.description}`;
      const hit = snapshotCache.get(key);
      if (hit && Date.now() - hit.cachedAt.getTime() < SNAPSHOT_CACHE_MS) {
        return { items: hit.items, cachedAt: hit.cachedAt.toISOString() };
      }
      const items = await withRepo(settings, async (restic, repo) => {
        try {
          return (await restic.snapshots(repo)).map(snapshotOf);
        } catch (err) {
          if (!(err instanceof ResticError)) throw err;
          // A repository not made yet holds no snapshots.
          if (err.reason === 'no_repository') return [];
          throw new AppError('restic_failed', 502, undefined, {
            reason: RESTIC_ERROR_REASONS.includes(err.reason) ? err.reason : 'failed',
          });
        }
      });
      const cachedAt = new Date();
      snapshotCache.clear();
      snapshotCache.set(key, { items, cachedAt });
      return { items, cachedAt: cachedAt.toISOString() };
    });
  });
}
