import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { id, textEnum, tstz } from './common.js';

// Admin alerts (task 25; D166, D185): instance scope. kept_app reads them only as an instance
// admin; kept_system raises and resolves them (migration 0011). Not synced to phones, so no
// row_version: `last_at` and `count` are the alert's own bookkeeping.

/** What an alert is about. A new kind is a constraint change (D183), in the step that adds it. */
export const ADMIN_ALERT_KINDS = [
  /** More than 5 jobs failed in the last hour (D166). */
  'failed_jobs_rising',
  /** audit_events_default holds rows: a month's partition was missing when they were written,
   * and kept.ensure_audit_partitions() refuses to create it until they are moved (0005). */
  'audit_default_partition',
  /** llm_calls_default holds rows: a month's ledger partition was missing (step 3, T6). */
  'llm_default_partition',
  /** The instance key's monthly cap passed 80%, or reached 100% (D206). */
  'ai_instance_cap_warning',
  'ai_instance_cap_reached',
  /** The instance key was refused by its provider (401/403, D206). */
  'ai_instance_key_rejected',
  /** The nightly backup failed (T31c, D207): the error and when the last good one ran. */
  'backup_failed',
  /** The reminder scan hasn't completed for 2 hours (step 4, D166, §3.4). */
  'reminders_not_scanned',
  /** No good backup in more than 26 hours (step 8 T10, D66): the nightly one stopped running. */
  'backup_stale',
  /** The data volume or the backup target is nearly full (step 8 T10). */
  'disk_space_low',
  /** The S3 backup bucket has versioning (or object lock) off, so a stolen key can erase it
   * (step 8 T5, D66). */
  'bucket_versioning_off',
  /** No restore drill in the last 90 days (step 8 T7, D66). */
  'restore_drill_due',
  /** A snapshot came out much smaller than the last good one, so its retention was skipped
   * (step 8 T5). */
  'backup_suspicious_size',
  /** A location webhook started failing (step 6 T15): its failing_since was set. */
  'webhook_failing',
] as const;
export type AdminAlertKind = (typeof ADMIN_ALERT_KINDS)[number];
const alertKind = textEnum('kind', ADMIN_ALERT_KINDS);

export const adminAlerts = pgTable(
  'admin_alerts',
  {
    id: id(),
    kind: alertKind.col().notNull(),
    /** One row per condition: raising it again counts, it doesn't add a row. */
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** When this occurrence began (reset when a resolved alert is raised again). */
    firstAt: tstz('first_at').notNull().defaultNow(),
    lastAt: tstz('last_at').notNull().defaultNow(),
    count: integer('count').notNull().default(1),
    resolvedAt: tstz('resolved_at'),
    /** The last time the instance admins were mailed about it: at most once per 24 h per key. */
    mailedAt: tstz('mailed_at'),
    /** The latest figures (counts, dates); never tenant content. */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  },
  () => [
    alertKind.check('admin_alerts'),
    check('admin_alerts_count_chk', sql`count >= 1`),
    check('admin_alerts_seen_chk', sql`last_at >= first_at`),
  ],
);
