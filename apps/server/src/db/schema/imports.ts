import {
  IMPORT_ENTITY_TYPES,
  IMPORT_SOURCE_ID_SOURCES,
  IMPORT_SOURCES,
  IMPORT_STATUSES,
} from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';

// Imports (step-3 plan T5; engineering spec §1.10, §7.13; D73, D146; plan Q18). CSV (step 3),
// Homebox and Kept archives (step 7, 0079). Owners and admins only (§7.1): row-level security in
// 0038, and 0080 for an archive run with no target yet (its creator's alone).

export { IMPORT_ENTITY_TYPES, IMPORT_SOURCES, IMPORT_STATUSES };

const runSource = textEnum('source', IMPORT_SOURCES);
const runStatus = textEnum('status', IMPORT_STATUSES);
const sourceIdSource = textEnum('source', IMPORT_SOURCE_ID_SOURCES);
const entityType = textEnum('entity_type', IMPORT_ENTITY_TYPES);

/**
 * One import: the mapping and choices, the rows as received (strings, cleared when done), the
 * dry run's report and how far the resumable job has got. An archive run (step 7) is uploaded
 * and inspected before its target is chosen, so its location is null until
 * `kept.set_import_target()` sets it once (kept_app holds no grant on `location_id`). The
 * archive itself is the blob `i/<id>.zip`; a Kept export's passphrase-derived key is sealed under
 * the keyring (AAD `import_runs|<id>|secrets_key`, secrets/rotate.ts) and cleared when the run
 * ends. Abandoned runs are cleared by the `prune-imports` job (kept.stale_import_runs()).
 */
export const importRuns = pgTable(
  'import_runs',
  {
    id: id(),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    source: runSource.col().notNull(),
    sourceVersion: text('source_version'),
    status: runStatus.col().notNull().default('draft'),
    mapping: jsonb('mapping').notNull().default(sql`'{}'::jsonb`),
    choices: jsonb('choices').notNull().default(sql`'{}'::jsonb`),
    rows: jsonb('rows'),
    dryRunReport: jsonb('dry_run_report'),
    progress: integer('progress').notNull().default(0),
    total: integer('total'),
    createdBy: uuid('created_by').notNull(),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    error: text('error'),
    archiveBytes: bigint('archive_bytes', { mode: 'number' }),
    archiveSha256: text('archive_sha256'),
    archiveReadyAt: tstz('archive_ready_at'),
    /** The manifest summary inspection read (plan T8), never an entity's data. */
    inspect: jsonb('inspect'),
    secretsKeyCiphertext: jsonb('secrets_key_ciphertext'),
    keyVersion: integer('key_version'),
    ...mutable(),
  },
  (t) => [
    runSource.check('import_runs'),
    runStatus.check('import_runs'),
    unique('import_runs_location_id_uq').on(t.locationId, t.id),
    check('import_runs_source_version_chk', sql`char_length(source_version) <= 40`),
    check('import_runs_mapping_chk', sql`jsonb_typeof(mapping) = 'object'`),
    check('import_runs_choices_chk', sql`jsonb_typeof(choices) = 'object'`),
    check('import_runs_rows_chk', sql`rows IS NULL OR jsonb_typeof(rows) = 'array'`),
    check('import_runs_progress_chk', sql`progress >= 0 AND (total IS NULL OR progress <= total)`),
    check('import_runs_error_chk', sql`char_length(error) <= 500`),
    index('import_runs_location_idx').on(t.locationId, t.createdAt),
    check(
      'import_runs_target_chk',
      sql`location_id IS NOT NULL OR status IN ('draft', 'failed', 'cancelled')`,
    ),
    check(
      'import_runs_archive_chk',
      sql`(archive_bytes IS NULL AND archive_sha256 IS NULL AND archive_ready_at IS NULL)
          OR source IN ('homebox_zip', 'kept_zip')`,
    ),
    check('import_runs_archive_bytes_chk', sql`archive_bytes >= 0`),
    check('import_runs_archive_sha256_chk', sql`archive_sha256 ~ '^[0-9a-f]{64}$'`),
    check('import_runs_inspect_chk', sql`inspect IS NULL OR jsonb_typeof(inspect) = 'object'`),
    check(
      'import_runs_secrets_key_chk',
      sql`(secrets_key_ciphertext IS NULL) = (key_version IS NULL)
          AND (secrets_key_ciphertext IS NULL OR source = 'kept_zip')`,
    ),
    index('import_runs_draft_idx').on(t.createdBy, t.createdAt).where(sql`location_id IS NULL`),
  ],
);

/** What a source's own id became, so a re-run updates instead of duplicating (§7.13: unique per
 * location). Never updated. */
export const importSourceIds = pgTable(
  'import_source_ids',
  {
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    source: sourceIdSource.col().notNull(),
    sourceId: text('source_id').notNull(),
    entityType: entityType.col().notNull(),
    entityId: uuid('entity_id').notNull(),
    runId: uuid('run_id').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'import_source_ids_pk', columns: [t.locationId, t.source, t.sourceId] }),
    sourceIdSource.check('import_source_ids'),
    entityType.check('import_source_ids'),
    check('import_source_ids_source_id_chk', sql`char_length(source_id) BETWEEN 1 AND 200`),
    foreignKey({
      name: 'import_source_ids_run_fk',
      columns: [t.locationId, t.runId],
      foreignColumns: [importRuns.locationId, importRuns.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('import_source_ids_run_idx').on(t.runId),
    index('import_source_ids_entity_idx').on(t.entityId),
  ],
);
