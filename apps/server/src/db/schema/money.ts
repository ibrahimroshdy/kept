import {
  EXPORT_RUN_KINDS,
  EXPORT_RUN_STATUSES,
  INCIDENT_KINDS,
  VALUATION_SOURCES,
} from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, mutable, textEnum, tstz } from './common.js';
import { currencies } from './currencies.js';
import { locations, ownerAccounts } from './tenancy.js';
import { things } from './things.js';

// Money records, incidents and export runs (step-4 plan T4; engineering spec §1.4, §1.10, §7.13;
// D14, D76, D136, D158, D169, D180, D201; plan Q19–Q22). Row-level security, the grants, the
// export-run doors and the AI money caps counted through exchange rates are in the custom
// migration that follows (0049); see src/db/money.test.ts.
//
// Money is numeric(16,4) with a currency (a foreign key to currencies), as for purchases; it is
// gated at serialisation (src/serialize/gates.ts), never by row-level security.

const valuationSource = textEnum('source', VALUATION_SOURCES);
const incidentKind = textEnum('kind', INCIDENT_KINDS);
const exportKind = textEnum('kind', EXPORT_RUN_KINDS);
const exportStatus = textEnum('status', EXPORT_RUN_STATUSES);

/**
 * An exchange rate an account entered (D136, D76): one per pair and date. A conversion uses the
 * newest rate valid on or before the date, or the inverse pair's; it never chains through a third
 * currency and never estimates (@kept/shared money.ts `convert`; kept.fx_rate() in SQL).
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    fromCcy: char('from_ccy', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    toCcy: char('to_ccy', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** One `from_ccy` is worth `rate` of `to_ccy`. */
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    validFrom: date('valid_from').notNull(),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    primaryKey({
      name: 'fx_rates_pk',
      columns: [t.ownerAccountId, t.fromCcy, t.toCcy, t.validFrom],
    }),
    check('fx_rates_rate_chk', sql`rate > 0`),
    check('fx_rates_pair_chk', sql`from_ccy <> to_ccy`),
  ],
);

/** A dated value of a thing (D158): its current value is the newest. */
export const valuations = pgTable(
  'valuations',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id').notNull(),
    value: numeric('value', { precision: 16, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    valuedOn: date('valued_on').notNull(),
    source: valuationSource.col().notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    valuationSource.check('valuations'),
    check('valuations_value_chk', sql`value >= 0`),
    check('valuations_notes_chk', sql`char_length(notes) <= 2000`),
    unique('valuations_location_id_uq').on(t.locationId, t.id),
    foreignKey({
      name: 'valuations_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('valuations_thing_idx').on(t.thingId, t.valuedOn.desc(), t.createdAt.desc()),
  ],
);

/** A burglary, fire, flood or loss grouping the things it touched (D158, D169). */
export const incidents = pgTable(
  'incidents',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: incidentKind.col().notNull(),
    occurredOn: date('occurred_on').notNull(),
    policeReference: text('police_reference'),
    insurerReference: text('insurer_reference'),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    incidentKind.check('incidents'),
    check('incidents_police_reference_chk', sql`char_length(police_reference) <= 100`),
    check('incidents_insurer_reference_chk', sql`char_length(insurer_reference) <= 100`),
    check('incidents_notes_chk', sql`char_length(notes) <= 5000`),
    unique('incidents_location_id_uq').on(t.locationId, t.id),
    index('incidents_location_idx').on(t.locationId, t.occurredOn),
  ],
);

/** The things an incident touched. Never updated: a thing is added or removed. */
export const incidentThings = pgTable(
  'incident_things',
  {
    locationId: uuid('location_id').notNull(),
    incidentId: uuid('incident_id').notNull(),
    thingId: uuid('thing_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'incident_things_pk', columns: [t.incidentId, t.thingId] }),
    foreignKey({
      name: 'incident_things_incident_fk',
      columns: [t.locationId, t.incidentId],
      foreignColumns: [incidents.locationId, incidents.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'incident_things_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('incident_things_thing_idx').on(t.thingId),
  ],
);

/**
 * An export built by a job and fetched through an expiring link (§1.10, D158, D180; Q19): a
 * claim pack (step 4), or step 7's Kept export of a location or of "my data" (`me`, the
 * requester's Personal location; 0079–0080). The file is a blob keyed by the run (`x/<id>.zip`,
 * the CHECK below),
 * not a `files` row, so it is never readable through an attachment (D177). Its link is
 * `/x/<token>`: only the token's sha256 is stored. No row_version: the job's own bookkeeping, as
 * for report_runs. The foreign key to incidents is ON DELETE SET NULL (incident_id), which
 * Drizzle can't declare: it is in 0049.
 */
export const exportRuns = pgTable(
  'export_runs',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: exportKind.col().notNull(),
    includeSecrets: boolean('include_secrets').notNull().default(false),
    incidentId: uuid('incident_id'),
    thingIds: uuid('thing_ids').array(),
    status: exportStatus.col().notNull().default('queued'),
    progressDone: integer('progress_done').notNull().default(0),
    progressTotal: integer('progress_total').notNull().default(0),
    storageKey: text('storage_key'),
    bytes: bigint('bytes', { mode: 'number' }),
    /** A short machine code, never a message with data. */
    error: text('error'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash'),
    tokenExpiresAt: tstz('token_expires_at'),
    revokedAt: tstz('revoked_at'),
    downloads: integer('downloads').notNull().default(0),
    lastDownloadedAt: tstz('last_downloaded_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    expiresAt: tstz('expires_at').notNull().default(sql`now() + interval '7 days'`),
    // Step 7 (0079): what a Kept export includes (`{history, aiCalls, readable, pdf, ended,
    // trashed, locale, digits}`), when its job began, the archive's SHA-256, and the key derived
    // from the owner's passphrase when it carries secrets (D68), sealed under the keyring (AAD
    // `export_runs|<id>|secrets_key`, secrets/rotate.ts) and cleared when the run ends.
    options: jsonb('options').notNull().default(sql`'{}'::jsonb`),
    startedAt: tstz('started_at'),
    sha256: text('sha256'),
    secretsKeyCiphertext: jsonb('secrets_key_ciphertext'),
    keyVersion: integer('key_version'),
  },
  (t) => [
    exportKind.check('export_runs'),
    exportStatus.check('export_runs'),
    unique('export_runs_token_hash_uq').on(t.tokenHash),
    check('export_runs_secrets_chk', sql`NOT include_secrets OR kind <> 'claim_pack'`),
    check('export_runs_scope_chk', sql`num_nonnulls(incident_id, thing_ids) <= 1`),
    check(
      'export_runs_progress_chk',
      sql`progress_done >= 0 AND progress_total >= 0 AND progress_done <= progress_total`,
    ),
    check('export_runs_error_chk', sql`error ~ '^[a-z_]{1,32}$'`),
    check('export_runs_token_hash_chk', sql`token_hash ~ '^[0-9a-f]{64}$'`),
    // The blob is the run's own key, never one a caller names (D157): kept.export_download()
    // hands this key to a request without a session.
    check(
      'export_runs_storage_key_chk',
      sql`storage_key IS NULL OR storage_key = 'x/' || id::text || '.zip'`,
    ),
    check('export_runs_thing_ids_chk', sql`cardinality(thing_ids) BETWEEN 1 AND 1000`),
    check(
      'export_runs_kind_scope_chk',
      sql`kind = 'claim_pack' OR num_nonnulls(incident_id, thing_ids) = 0`,
    ),
    check('export_runs_options_chk', sql`jsonb_typeof(options) = 'object'`),
    check('export_runs_sha256_chk', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      'export_runs_secrets_key_chk',
      sql`(secrets_key_ciphertext IS NULL) = (key_version IS NULL)
          AND (secrets_key_ciphertext IS NULL OR include_secrets)`,
    ),
    index('export_runs_location_idx').on(t.locationId, t.createdAt),
    index('export_runs_expires_idx').on(t.expiresAt),
    index('export_runs_creator_idx').on(t.createdBy, t.createdAt),
  ],
);
