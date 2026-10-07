import { REPORT_KINDS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, textEnum, tstz } from './common.js';
import { locations, ownerAccounts } from './tenancy.js';

// Generated reports (D201; step-2 plan T32). One row per request for an inventory PDF: who asked,
// what it covers, and how far the `report` job has got. The PDF itself is a blob keyed by the
// run's id alone (`r/<id>.pdf`, storage/blob-store.ts); both go 24 hours after the request
// (kept.purge_expired_reports(), the hourly `purge-reports` job). Row-level security, the grants
// and the purge door are in the custom migration that follows.

export const REPORT_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
const status = textEnum('status', REPORT_STATUSES);
// The insurance report (step 4, D158) is a second template on the same engine.
const kind = textEnum('kind', REPORT_KINDS);

/**
 * A report run. Its scope is one location (`location_id`) or an account's locations
 * (`owner_account_id`); `location_ids` are the locations it covers, fixed when it is requested
 * (and audited there), and still intersected with what the requester can see when the job reads.
 * `user_id` is set null when the requester's user is deleted, so the purge still finds the blob.
 */
export const reportRuns = pgTable(
  'report_runs',
  {
    id: id(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, {
      onDelete: 'cascade',
    }),
    locationIds: uuid('location_ids').array().notNull(),
    /** Step 5 (Q17): the vehicle of a `vehicle_history` run, in its location (the key is in
     * 0065, with the trigger that keeps location_ids with it when the thing moves). */
    thingId: uuid('thing_id'),
    kind: kind.col().notNull().default('inventory'),
    /** Filters, what to include, the language and digits: the request's body, validated. */
    options: jsonb('options').notNull().default(sql`'{}'::jsonb`),
    status: status.col().notNull().default('queued'),
    progressDone: integer('progress_done').notNull().default(0),
    progressTotal: integer('progress_total').notNull().default(0),
    bytes: bigint('bytes', { mode: 'number' }),
    /** A short machine code (`timeout`, `memory`, `render`, …), never a message with data. */
    error: text('error'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    expiresAt: tstz('expires_at').notNull().default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    status.check('report_runs'),
    kind.check('report_runs'),
    check('report_runs_scope_chk', sql`num_nonnulls(location_id, owner_account_id) = 1`),
    check(
      'report_runs_locations_chk',
      sql`cardinality(location_ids) BETWEEN 1 AND 1000
          AND (location_id IS NULL OR location_ids = ARRAY[location_id])`,
    ),
    check(
      'report_runs_thing_chk',
      sql`(kind = 'vehicle_history') = (thing_id IS NOT NULL)
          AND (thing_id IS NULL OR location_id IS NOT NULL)`,
    ),
    check('report_runs_options_chk', sql`jsonb_typeof(options) = 'object'`),
    check(
      'report_runs_progress_chk',
      sql`progress_done >= 0 AND progress_total >= 0 AND progress_done <= progress_total`,
    ),
    check('report_runs_error_chk', sql`error ~ '^[a-z_]{1,32}$'`),
    check('report_runs_expires_chk', sql`expires_at > created_at`),
    // The per-user rate limit counts the last hour's runs; the purge walks the expired ones.
    index('report_runs_user_idx').on(t.userId, t.createdAt),
    index('report_runs_expires_idx').on(t.expiresAt),
  ],
);
