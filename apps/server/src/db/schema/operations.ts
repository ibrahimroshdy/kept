import { BACKUP_RUN_KINDS, BACKUP_RUN_STATES, BACKUP_STORAGE_MODES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { textEnum, tstz } from './common.js';

// Operations (step-8 plan T4; engineering spec §1.10, §7.11; D64–D66, D186; plan Q9). Instance
// scope, no tenant column. Row-level security, the grants and the alpha's backup status moved into
// rows are in the custom migration that follows (0091); see src/db/operations.test.ts.

const runKind = textEnum('kind', BACKUP_RUN_KINDS);
const runStatus = textEnum('status', BACKUP_RUN_STATES);
const storageMode = textEnum('storage_mode', BACKUP_STORAGE_MODES);

/**
 * One backup, restore drill or verify run (the restic engine, step 8 T5–T8). Written only by
 * kept_owner (the worker's backup login, the CLI, `kept migrate`); instance admins read them on
 * Admin → Backups. `target` is a description of where it went, never a credential; `detail` holds
 * counts and digests, never tenant content.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    kind: runKind.col().notNull(),
    status: runStatus.col().notNull().default('running'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    storageMode: storageMode.col().notNull(),
    target: text('target').notNull(),
    snapshotId: text('snapshot_id'),
    dbBytes: bigint('db_bytes', { mode: 'number' }),
    bytesAdded: bigint('bytes_added', { mode: 'number' }),
    bytesTotal: bigint('bytes_total', { mode: 'number' }),
    filesTotal: integer('files_total'),
    filesNew: integer('files_new'),
    missing: integer('missing').notNull().default(0),
    readableLocations: integer('readable_locations'),
    readableBytes: bigint('readable_bytes', { mode: 'number' }),
    sameVolume: boolean('same_volume'),
    bucketVersioningOk: boolean('bucket_versioning_ok'),
    /** A pre-upgrade snapshot's versions (T8). */
    fromVersion: text('from_version'),
    toVersion: text('to_version'),
    verifiedAt: tstz('verified_at'),
    /** A short machine code, never a message with data. */
    error: text('error'),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    runKind.check('backup_runs'),
    runStatus.check('backup_runs'),
    storageMode.check('backup_runs'),
    check('backup_runs_target_chk', sql`char_length(target) BETWEEN 1 AND 300`),
    check('backup_runs_snapshot_id_chk', sql`snapshot_id ~ '^[0-9a-f]{8,64}$'`),
    check('backup_runs_error_chk', sql`error ~ '^[a-z_]{1,48}$'`),
    check('backup_runs_detail_chk', sql`jsonb_typeof(detail) = 'object'`),
    check('backup_runs_finished_chk', sql`(status = 'running') = (finished_at IS NULL)`),
    check('backup_runs_missing_chk', sql`missing >= 0`),
    index('backup_runs_started_idx').on(t.startedAt.desc()),
    index('backup_runs_kind_idx').on(t.kind, t.startedAt.desc()),
  ],
);

/**
 * Every release this database was migrated by (plan Q9, T8): the downgrade guard compares the
 * running image with it. Written by kept_owner in `kept migrate` (a `0.0.0-dev` build isn't
 * recorded); the worker's boot guard reads it and stamps `last_booted_at`.
 */
export const releaseHistory = pgTable(
  'release_history',
  {
    version: text('version').primaryKey(),
    revision: text('revision'),
    /** The journal tag this release's image ends at. */
    lastMigration: text('last_migration').notNull(),
    firstMigratedAt: tstz('first_migrated_at').notNull().defaultNow(),
    lastBootedAt: tstz('last_booted_at'),
  },
  () => [
    check('release_history_version_chk', sql`version ~ '^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$'`),
    check('release_history_revision_chk', sql`revision ~ '^[0-9a-f]{7,40}$'`),
    check('release_history_last_migration_chk', sql`char_length(last_migration) BETWEEN 1 AND 100`),
  ],
);
