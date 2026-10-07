import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { installPgBoss } from '../jobs/install.js';
import { packageRoot } from '../package-root.js';
import {
  auditDowngradeForced,
  DowngradeRefused,
  decideRelease,
  isRecordedVersion,
  migrationLevel,
  newestRelease,
  type ReleaseRow,
  readReleases,
  recordRelease,
  UPGRADE_WITHOUT_SNAPSHOT_KEY,
} from './release-guard.js';
import { seedReference } from './seed-reference.js';

// Advisory lock key, so concurrent `kept migrate` invocations (or a migrate racing a boot-time
// caller) serialise instead of racing drizzle's own migration bookkeeping (§7.12).
const LOCK_KEY = 0x6b657074; // 'kept'
const LOCK_POLL_MS = 250;

export const migrationsFolder = path.join(packageRoot(import.meta.url), 'migrations');

export type MigrateErrorCode = 'migrate_lock_timeout' | 'pre_upgrade_snapshot_failed';

export class MigrateError extends Error {
  readonly code: MigrateErrorCode;

  constructor(message: string, code: MigrateErrorCode) {
    super(message);
    this.name = 'MigrateError';
    this.code = code;
  }
}

/**
 * The pre-upgrade snapshot (step-8 plan T8, Q8): a database-only backup before `kept migrate`
 * changes a populated database. `client` is the migrator's own owner connection (it holds the
 * advisory lock). Resolves `taken`, or `no_target` when no backup is configured (no target, or
 * no password: a loud line and a status-page note, never a refusal, as a first install has no
 * backup yet); throws when one is configured and the snapshot fails, which stops the migration.
 */
export type PreUpgradeSnapshot = (info: {
  client: pg.Client;
  fromVersion: string | null;
  toVersion: string;
}) => Promise<'taken' | 'no_target'>;

export type RunMigrationsOptions = {
  /** How long to wait for another migrator to finish before giving up. Default 60 s. */
  lockTimeoutMs?: number;
  /** The migrations folder (tests: a copy with the journal cut short). Default the image's. */
  folder?: string;
  /**
   * Step 8 (T8, Q9): the image migrating. Given, the downgrade guard runs before anything is
   * applied (one-version rollback allowed, more refused with `downgrade_refused`), and the
   * release is recorded in release_history afterwards (a `0.0.0-dev` build isn't).
   */
  release?: { version: string; revision: string | null };
  /** KEPT_ALLOW_DOWNGRADE=1 / `--allow-downgrade`: start anyway, audited. */
  allowDowngrade?: boolean;
  /** Takes the pre-upgrade snapshot when migrations are pending on a populated database; null
   * or absent (KEPT_UPGRADE_SNAPSHOT=off, `--skip-snapshot`): none is taken. */
  snapshot?: PreUpgradeSnapshot | null;
  /** Where the loud lines go (the CLI: stderr). */
  log?: (line: string) => void;
};

export type MigrationOutcome = {
  applied: number;
  snapshot: 'taken' | 'no_target' | 'skipped' | 'not_needed';
  /** A one-version rollback (or a forced downgrade): the newer release the database is from. */
  rolledBackFrom: string | null;
  recorded: boolean;
};

/** Polls pg_try_advisory_lock rather than blocking in pg_advisory_lock, so a stuck migrator
 * elsewhere turns into a clear error here instead of a hang. */
async function acquireLock(client: pg.Client, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      LOCK_KEY,
    ]);
    if (rows[0]?.ok) return;
    if (Date.now() >= deadline) {
      throw new MigrateError(
        `another migration held the lock for more than ${Math.round(timeoutMs / 1000)} s`,
        'migrate_lock_timeout',
      );
    }
    await sleep(Math.min(LOCK_POLL_MS, Math.max(deadline - Date.now(), 0)));
  }
}

export async function runMigrations(
  ownerUrl: string,
  opts: RunMigrationsOptions = {},
): Promise<MigrationOutcome> {
  const client = new pg.Client({ connectionString: ownerUrl });
  // A backend terminated while idle is emitted as 'error'; unhandled, it would crash the
  // process instead of failing the next query.
  client.on('error', () => {});
  await client.connect();
  let failed = false;
  let locked = false;
  try {
    await acquireLock(client, opts.lockTimeoutMs ?? 60_000);
    locked = true;
    const folder = opts.folder ?? migrationsFolder;
    const log = opts.log ?? (() => {});
    const level = await migrationLevel(client, folder);
    // release_history exists from 0090 on; an older database has none to read.
    const releases: ReleaseRow[] = level.populated
      ? await readReleases(client).catch(() => [])
      : [];
    const outcome: MigrationOutcome = {
      applied: level.pending.length,
      snapshot: 'not_needed',
      rolledBackFrom: null,
      recorded: false,
    };

    // The downgrade guard (Q9), before anything changes.
    if (opts.release && level.unknown.length > 0) {
      const decision = decideRelease({
        imageVersion: opts.release.version,
        ahead: true,
        releases,
      });
      if (decision.state === 'rollback') {
        outcome.rolledBackFrom = decision.from;
        log(
          `kept: rolling back from Kept ${decision.from} to ${opts.release.version}; its migrations stay (D82)`,
        );
      } else if (decision.state === 'refused') {
        if (!isRecordedVersion(opts.release.version)) {
          log(
            'kept: a development build on a database a newer build migrated; not refused in development',
          );
        } else if (!opts.allowDowngrade) {
          throw new DowngradeRefused(opts.release.version, decision.newest, decision.why);
        } else {
          await auditDowngradeForced(client, opts.release.version, decision.newest);
          log(
            `kept: KEPT_ALLOW_DOWNGRADE=1: migrating a database from Kept ${decision.newest ?? 'unknown'} with ${opts.release.version} (audited)`,
          );
          outcome.rolledBackFrom = decision.newest;
        }
      }
    }

    // The pre-upgrade snapshot (Q8): only a populated database with something pending.
    if (level.populated && level.pending.length > 0) {
      if (!opts.snapshot) {
        outcome.snapshot = 'skipped';
        log('kept: migrating without a pre-upgrade snapshot (skipped)');
      } else {
        const fromVersion = newestRelease(releases);
        const toVersion = opts.release?.version ?? 'unknown';
        try {
          outcome.snapshot = await opts.snapshot({ client, fromVersion, toVersion });
        } catch (err) {
          throw new MigrateError(
            `the pre-upgrade snapshot failed, so nothing was migrated: ${err instanceof Error ? err.message : String(err)}. Fix the backup, or migrate without one (--skip-snapshot or KEPT_UPGRADE_SNAPSHOT=off)`,
            'pre_upgrade_snapshot_failed',
          );
        }
        if (outcome.snapshot === 'no_target') {
          log(
            `kept: NO BACKUP IS CONFIGURED: upgrading ${fromVersion ?? 'this database'} to ${toVersion} without a snapshot. Set up backups in Admin → Backups.`,
          );
          await client.query(
            `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            [
              UPGRADE_WITHOUT_SNAPSHOT_KEY,
              JSON.stringify({
                fromVersion: fromVersion ?? 'unknown',
                toVersion,
                at: new Date().toISOString(),
              }),
            ],
          );
        }
      }
    }

    await migrate(drizzle(client), {
      migrationsFolder: folder,
      migrationsTable: 'migrations',
      migrationsSchema: 'kept_meta',
    });
    // pg-boss ships its own versioned SQL; it is installed as kept_owner here, never at runtime.
    await installPgBoss(client);
    // Reference rows (currencies, the built-in type library): upserted every run, idempotent.
    await seedReference(client);
    // Release history (Q9): after a successful migration, never for a development build.
    if (opts.release) outcome.recorded = await recordRelease(client, opts.release, folder);
    return outcome;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // Cleanup errors must not replace the error that got us here.
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end().catch((endErr: unknown) => {
      if (!failed) throw endErr;
    });
  }
}
