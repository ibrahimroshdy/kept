import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compareSemver, parseSemver } from '@kept/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { packageRoot } from '../package-root.js';
import * as schema from './schema/index.js';

// Upgrade safety (step-8 plan T8, Q8, Q9; D66, D82): which releases migrated this database, and
// whether this image may run on it.
//
// `release_history` records each release `kept migrate` ran (its version, revision and the last
// journal tag its image carries). Migrations are additive (D82), so the previous release still
// runs on a database the next one migrated: **one-version rollback** is allowed. A database more
// than one recorded release ahead, or ahead of this image and of every recorded release, is
// refused with `downgrade_refused` unless the operator forces it (KEPT_ALLOW_DOWNGRADE=1 or
// `kept migrate --allow-downgrade`), which is audited as `instance.downgrade_forced`.
//
// "Ahead" means the database holds a migration this image's journal doesn't know:
// - `kept migrate` (kept_owner) reads drizzle's own log, kept_meta.migrations, whose `created_at`
//   is each migration's journal `when`;
// - the server's boot (kept_system, which never sees kept_meta) compares the recorded releases'
//   `last_migration` tags with the journal: a release whose last tag this image doesn't know
//   migrated past it.
// Development builds (`0.0.0-dev`) are never recorded and never refused: a branch switch in
// development is not a downgrade (they log the finding instead).

/** The status page's "Upgraded from X to Y without a snapshot" (plan T8), until the next good
 * backup: `{fromVersion, toVersion, at}`, written by `kept migrate` as kept_owner. */
export const UPGRADE_WITHOUT_SNAPSHOT_KEY = 'upgrade_without_snapshot';

export const DEV_VERSION = '0.0.0-dev';

/** The runbook a refusal names. */
export const RESTORE_RUNBOOK = 'docs/runbooks/backup-restore.md';

export type JournalEntry = { tag: string; when: number };

let journalCache: { folder: string; entries: JournalEntry[] } | null = null;

/** The image's migrations folder (as db/migrate.ts resolves it). */
export function migrationsFolderOf(): string {
  return path.join(packageRoot(import.meta.url), 'migrations');
}

/** The image's migration journal, in order. */
export function imageJournal(folder: string = migrationsFolderOf()): JournalEntry[] {
  if (journalCache?.folder === folder) return journalCache.entries;
  const raw = JSON.parse(readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  const entries = raw.entries.map((e) => ({ tag: e.tag, when: e.when }));
  journalCache = { folder, entries };
  return entries;
}

/** The last journal tag this image carries. */
export function imageLastMigration(folder?: string): string | null {
  return imageJournal(folder).at(-1)?.tag ?? null;
}

/** A version release_history records: a real semver, never a development build. */
export function isRecordedVersion(version: string): boolean {
  return version !== DEV_VERSION && parseSemver(version) !== null;
}

export type ReleaseRow = { version: string; revision: string | null; lastMigration: string };

export type ReleaseDecision =
  | { state: 'ok' }
  | { state: 'rollback'; from: string }
  | { state: 'refused'; newest: string | null; why: 'too_far' | 'unknown' };

/**
 * The guard's rule (plan Q9). `ahead`: the database holds migrations this image doesn't know.
 * `aheadReleases`: the recorded releases that introduced them (when the caller can tell; the
 * boot passes the releases whose last tag the journal lacks).
 */
export function decideRelease(input: {
  imageVersion: string;
  ahead: boolean;
  releases: readonly ReleaseRow[];
  aheadReleases?: readonly ReleaseRow[];
}): ReleaseDecision {
  if (!input.ahead) return { state: 'ok' };
  const recorded = input.releases
    .filter((r) => parseSemver(r.version))
    .sort((a, b) => compareSemver(a.version, b.version));
  const newest = recorded.at(-1)?.version ?? null;
  if (!isRecordedVersion(input.imageVersion)) return { state: 'refused', newest, why: 'unknown' };
  const newer = recorded.filter((r) => compareSemver(r.version, input.imageVersion) > 0);
  // Unknown to release_history: migrated by something no release recorded.
  if (newer.length === 0) return { state: 'refused', newest, why: 'unknown' };
  if (input.aheadReleases && input.aheadReleases.length === 0) {
    return { state: 'refused', newest, why: 'unknown' };
  }
  // Exactly one release ahead, the next one after this image's version.
  if (newer.length === 1) return { state: 'rollback', from: (newer[0] as ReleaseRow).version };
  return { state: 'refused', newest, why: 'too_far' };
}

export class DowngradeRefused extends Error {
  readonly code = 'downgrade_refused' as const;

  constructor(imageVersion: string, newest: string | null, why: 'too_far' | 'unknown') {
    super(
      why === 'too_far'
        ? `downgrade_refused: this database was migrated by Kept ${newest}, more than one release ahead of this image (${imageVersion}). Run ${newest} or the release before it, or restore a backup taken by ${imageVersion} (${RESTORE_RUNBOOK}); KEPT_ALLOW_DOWNGRADE=1 forces it.`
        : `downgrade_refused: this database holds migrations this image (${imageVersion}) doesn't know, from ${newest ? `a release after Kept ${newest}` : 'no recorded release'}. Run the release that migrated it, or restore a backup taken by ${imageVersion} (${RESTORE_RUNBOOK}); KEPT_ALLOW_DOWNGRADE=1 forces it.`,
    );
    this.name = 'DowngradeRefused';
  }
}

export async function readReleases(client: Pick<pg.ClientBase, 'query'>): Promise<ReleaseRow[]> {
  const { rows } = await client.query<{
    version: string;
    revision: string | null;
    last_migration: string;
  }>('SELECT version, revision, last_migration FROM public.release_history');
  return rows.map((r) => ({
    version: r.version,
    revision: r.revision,
    lastMigration: r.last_migration,
  }));
}

/** The audit row for a forced start (kept_owner or kept_system, both may write system events). */
export async function auditDowngradeForced(
  client: pg.Client | pg.PoolClient,
  imageVersion: string,
  newest: string | null,
): Promise<void> {
  await audited(drizzle(client, { schema }), {
    locationId: null,
    ownerAccountId: null,
    actor: { type: 'system', id: null },
    action: 'instance.downgrade_forced',
    entity: { type: 'release_history', id: null },
    after: { imageVersion, newestVersion: newest },
  });
}

export type BootGuardResult = { rolledBackFrom: string | null; forced: boolean };

/**
 * The server's boot check (plan T8), as kept_system: refuses a database more than one recorded
 * release ahead (throws DowngradeRefused) unless `allowDowngrade`, logs a one-version rollback,
 * and stamps this release's `last_booted_at`.
 */
export async function bootReleaseGuard(
  client: pg.Client | pg.PoolClient,
  opts: {
    imageVersion: string;
    allowDowngrade: boolean;
    log: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
    folder?: string;
  },
): Promise<BootGuardResult> {
  const releases = await readReleases(client);
  const known = new Set(imageJournal(opts.folder).map((e) => e.tag));
  const aheadReleases = releases.filter((r) => !known.has(r.lastMigration));
  const decision = decideRelease({
    imageVersion: opts.imageVersion,
    ahead: aheadReleases.length > 0,
    releases,
    aheadReleases,
  });
  let result: BootGuardResult = { rolledBackFrom: null, forced: false };
  if (decision.state === 'rollback') {
    opts.log.warn(
      { from: decision.from, to: opts.imageVersion },
      `rolled back from Kept ${decision.from} to ${opts.imageVersion}: its migrations stay (D82)`,
    );
    result = { rolledBackFrom: decision.from, forced: false };
  } else if (decision.state === 'refused') {
    if (!isRecordedVersion(opts.imageVersion)) {
      opts.log.warn(
        { newest: decision.newest },
        'a development build on a database a newer release migrated; not refused in development',
      );
    } else if (!opts.allowDowngrade) {
      throw new DowngradeRefused(opts.imageVersion, decision.newest, decision.why);
    } else {
      await auditDowngradeForced(client, opts.imageVersion, decision.newest);
      opts.log.warn(
        { newest: decision.newest, image: opts.imageVersion },
        'KEPT_ALLOW_DOWNGRADE=1: starting on a database more than one release ahead (audited)',
      );
      result = { rolledBackFrom: decision.newest, forced: true };
    }
  }
  if (isRecordedVersion(opts.imageVersion)) {
    await client.query(
      'UPDATE public.release_history SET last_booted_at = now() WHERE version = $1',
      [opts.imageVersion],
    );
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// `kept migrate`'s side (kept_owner)

export type MigrationLevel = {
  /** kept_meta.migrations has rows: a populated database (a fresh one takes no snapshot). */
  populated: boolean;
  /** Journal entries the database hasn't applied yet. */
  pending: JournalEntry[];
  /** Applied migrations (their `created_at`, the journal `when`) this image doesn't know. */
  unknown: number[];
};

/** Where the database stands against this image's journal (drizzle applies every entry whose
 * `when` is after the newest `created_at` it logged). */
export async function migrationLevel(
  client: Pick<pg.ClientBase, 'query'>,
  folder?: string,
): Promise<MigrationLevel> {
  const journal = imageJournal(folder);
  const { rows: reg } = await client.query<{ reg: string | null }>(
    `SELECT to_regclass('kept_meta.migrations')::text AS reg`,
  );
  if (!reg[0]?.reg) return { populated: false, pending: journal, unknown: [] };
  const { rows } = await client.query<{ created_at: string }>(
    'SELECT created_at::text AS created_at FROM kept_meta.migrations',
  );
  const applied = rows.map((r) => Number(r.created_at));
  if (applied.length === 0) return { populated: false, pending: journal, unknown: [] };
  const whens = new Set(journal.map((e) => e.when));
  const newest = Math.max(...applied);
  return {
    populated: true,
    pending: journal.filter((e) => e.when > newest),
    unknown: applied.filter((w) => !whens.has(w)),
  };
}

const REVISION = /^[0-9a-f]{7,40}$/;

/** After migrating: this release's row (a development build isn't recorded). */
export async function recordRelease(
  client: Pick<pg.ClientBase, 'query'>,
  release: { version: string; revision: string | null },
  folder?: string,
): Promise<boolean> {
  if (!isRecordedVersion(release.version)) return false;
  const last = imageLastMigration(folder);
  if (!last) return false;
  const revision = release.revision && REVISION.test(release.revision) ? release.revision : null;
  await client.query(
    `INSERT INTO public.release_history (version, revision, last_migration)
     VALUES ($1, $2, $3)
     ON CONFLICT (version) DO UPDATE
       SET revision = coalesce(excluded.revision, release_history.revision),
           last_migration = excluded.last_migration`,
    [release.version, revision, last],
  );
  return true;
}

/** The newest recorded release, the "from" of an upgrade (null on a database none recorded). */
export function newestRelease(releases: readonly ReleaseRow[]): string | null {
  const recorded = releases
    .filter((r) => parseSemver(r.version))
    .sort((a, b) => compareSemver(a.version, b.version));
  return recorded.at(-1)?.version ?? null;
}
