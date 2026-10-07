import { CAPTURE_MODES, EXTRACTION_STATUSES, INBOX_KINDS, INBOX_RESOLUTIONS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { attachments, files } from './files.js';
import { meterReadings, meters } from './meters.js';
import { purchases } from './purchases.js';
import { types } from './registries.js';
import { serviceRecords } from './services.js';
import { locations, ownerAccounts } from './tenancy.js';
import { things } from './things.js';

// Capture records (step-3 plan T5; engineering spec §1.5, §1.8, §7.8, §7.13; D18, D36, D76, D77,
// D112, D175, D177; plan Q14, Q15, Q17). Row-level security, the guards, the file-text search
// door and the grants are in the custom migration that follows (0038); see
// src/db/capture.test.ts.

/** Postgres full-text vector (as in things.ts). */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const mode = textEnum('mode', CAPTURE_MODES);
const status = textEnum('status', EXTRACTION_STATUSES);

/**
 * One extraction of one attachment (§7.8): what the model read, after the code checks
 * (`result`), and what auto-accept wrote (`applied`). Re-running is explicit and adds an attempt
 * (D19); only one attempt of an attachment is live at a time. `llm_call_id` is not a foreign
 * key: the ledger is partitioned and outlives it.
 */
export const extractions = pgTable(
  'extractions',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id').notNull(),
    thingId: uuid('thing_id'),
    purchaseId: uuid('purchase_id'),
    meterId: uuid('meter_id'),
    /** Step 5 (Q12): the draft service record whose invoice this reads; set at insert only. */
    serviceRecordId: uuid('service_record_id'),
    mode: mode.col().notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: status.col().notNull().default('queued'),
    statusReason: text('status_reason'),
    pausedUntil: tstz('paused_until'),
    llmCallId: uuid('llm_call_id'),
    /** The output-token cap a retry runs at, learned from a truncated or refused-for-length call
     * (step 6; the provider's learned output limit, 0045). NULL: the default allowance. */
    outputCap: integer('output_cap'),
    result: jsonb('result'),
    applied: jsonb('applied').notNull().default(sql`'{}'::jsonb`),
    requestedBy: uuid('requested_by').notNull(),
    ...mutable(),
  },
  (t) => [
    mode.check('extractions'),
    status.check('extractions'),
    unique('extractions_location_id_uq').on(t.locationId, t.id),
    unique('extractions_attempt_uq').on(t.attachmentId, t.attempt),
    check('extractions_attempt_chk', sql`attempt BETWEEN 1 AND 50`),
    check('extractions_status_reason_chk', sql`char_length(status_reason) <= 60`),
    check('extractions_output_cap_chk', sql`output_cap BETWEEN 64 AND 200000`),
    check(
      'extractions_one_draft_chk',
      sql`num_nonnulls(thing_id, purchase_id, meter_id, service_record_id) <= 1`,
    ),
    check('extractions_result_chk', sql`result IS NULL OR jsonb_typeof(result) = 'object'`),
    check('extractions_applied_chk', sql`jsonb_typeof(applied) = 'object'`),
    foreignKey({
      name: 'extractions_attachment_fk',
      columns: [t.locationId, t.attachmentId],
      foreignColumns: [attachments.locationId, attachments.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'extractions_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'extractions_purchase_fk',
      columns: [t.locationId, t.purchaseId],
      foreignColumns: [purchases.locationId, purchases.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'extractions_meter_fk',
      columns: [t.locationId, t.meterId],
      foreignColumns: [meters.locationId, meters.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'extractions_service_record_fk',
      columns: [t.locationId, t.serviceRecordId],
      foreignColumns: [serviceRecords.locationId, serviceRecords.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // One live attempt per attachment: a second queue of the same photo is refused (23505).
    uniqueIndex('extractions_live_uq')
      .on(t.attachmentId)
      .where(sql`status IN ('queued', 'running', 'paused_budget', 'waiting_provider')`),
    index('extractions_thing_idx').on(t.thingId).where(sql`thing_id IS NOT NULL`),
    index('extractions_purchase_idx').on(t.purchaseId).where(sql`purchase_id IS NOT NULL`),
    index('extractions_service_record_idx')
      .on(t.serviceRecordId)
      .where(sql`service_record_id IS NOT NULL`),
    // The rollover and "Resume now" re-send paused work, oldest first (T6's doors).
    index('extractions_paused_idx')
      .on(t.locationId, t.createdAt)
      .where(sql`status = 'paused_budget'`),
  ],
);

const inboxKind = textEnum('kind', INBOX_KINDS);
const resolution = textEnum('resolution', INBOX_RESOLUTIONS);

/**
 * "To review" (§7.8; D18, D36, D112, D175, D191): a decision waiting on a person. Members and
 * above (writable locations) see a location's items; "Mine" is `created_by`. Rows go with their
 * subject (cascades); resolved ones are pruned after 90 days (plan Q15), the decision itself
 * living on in the audit.
 */
export const inboxItems = pgTable(
  'inbox_items',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: inboxKind.col().notNull(),
    thingId: uuid('thing_id'),
    purchaseId: uuid('purchase_id'),
    meterReadingId: uuid('meter_reading_id'),
    extractionId: uuid('extraction_id'),
    otherThingId: uuid('other_thing_id'),
    code: char('code', { length: 6 }),
    batchId: uuid('batch_id'),
    createdBy: uuid('created_by').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    resolvedAt: tstz('resolved_at'),
    resolvedBy: uuid('resolved_by'),
    resolution: resolution.col(),
    ...mutable(),
  },
  (t) => [
    inboxKind.check('inbox_items'),
    resolution.check('inbox_items'),
    unique('inbox_items_location_id_uq').on(t.locationId, t.id),
    check('inbox_items_code_chk', sql`code ~ '^[0-9A-HJKMNP-TV-Z]{6}$'`),
    check('inbox_items_payload_chk', sql`jsonb_typeof(payload) = 'object'`),
    check('inbox_items_resolved_chk', sql`(resolved_at IS NULL) = (resolution IS NULL)`),
    check(
      'inbox_items_subject_chk',
      sql`kind = 'sync_drop' OR num_nonnulls(thing_id, purchase_id, meter_reading_id, code) >= 1`,
    ),
    foreignKey({
      name: 'inbox_items_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'inbox_items_purchase_fk',
      columns: [t.locationId, t.purchaseId],
      foreignColumns: [purchases.locationId, purchases.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'inbox_items_meter_reading_fk',
      columns: [t.locationId, t.meterReadingId],
      foreignColumns: [meterReadings.locationId, meterReadings.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'inbox_items_extraction_fk',
      columns: [t.locationId, t.extractionId],
      foreignColumns: [extractions.locationId, extractions.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'inbox_items_other_thing_fk',
      columns: [t.locationId, t.otherThingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // One open item per kind and subject (and duplicate pair, and code).
    uniqueIndex('inbox_open_subject_uq')
      .on(
        t.kind,
        sql`coalesce(thing_id, purchase_id, meter_reading_id)`,
        sql`coalesce(other_thing_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(code, '')`,
      )
      .where(sql`resolved_at IS NULL`),
    index('inbox_open_loc_idx')
      .on(t.locationId, t.createdAt.desc(), t.id)
      .where(sql`resolved_at IS NULL`),
    index('inbox_open_mine_idx')
      .on(t.createdBy, t.createdAt.desc(), t.id)
      .where(sql`resolved_at IS NULL`),
    index('inbox_resolved_idx').on(t.resolvedAt).where(sql`resolved_at IS NOT NULL`),
    index('inbox_items_thing_idx').on(t.thingId).where(sql`thing_id IS NOT NULL`),
  ],
);

/**
 * A template (D76, D177; plan Q17): account-level, shared into chosen locations
 * (`template_locations`), where members use it. Editing needs admin of every location it is
 * shared with. The payload's keys are the API's to police (T19): never money, never a secret.
 */
export const templates = pgTable(
  'templates',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    typeId: uuid('type_id').references(() => types.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by').notNull(),
    archivedAt: tstz('archived_at'),
    ...mutable(),
  },
  (t) => [
    unique('templates_owner_account_id_uq').on(t.ownerAccountId, t.id),
    check('templates_name_chk', sql`char_length(name) BETWEEN 1 AND 80`),
    check('templates_payload_chk', sql`jsonb_typeof(payload) = 'object'`),
    index('templates_type_idx').on(t.typeId),
  ],
);

/** Where a template may be used. Always a location of the template's own account (a guard). */
export const templateLocations = pgTable(
  'template_locations',
  {
    templateId: uuid('template_id').notNull(),
    ownerAccountId: uuid('owner_account_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ name: 'template_locations_pk', columns: [t.templateId, t.locationId] }),
    foreignKey({
      name: 'template_locations_template_fk',
      columns: [t.ownerAccountId, t.templateId],
      foreignColumns: [templates.ownerAccountId, templates.id],
    }).onDelete('cascade'),
    index('template_locations_location_idx').on(t.locationId),
  ],
);

export const FILE_TEXT_SOURCES = ['pdf', 'extraction'] as const;
const fileTextSource = textEnum('source', FILE_TEXT_SOURCES);

/**
 * A file's text, for document search and RECEIPT extraction (§1.5, D77; T21 fills it from PDFs,
 * T10 from extraction). It follows its file (§7.2): visible exactly when the file is. Its search
 * runs through kept.search_file_ids() (0038), since `@@` under RLS can't use the index. A
 * receipt's text holds prices: the search route never shows a snippet of it without the money
 * gate (T21).
 */
export const fileText = pgTable(
  'file_text',
  {
    fileId: uuid('file_id').primaryKey(),
    locationId: uuid('location_id').notNull(),
    source: fileTextSource.col().notNull(),
    text: text('text').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', kept.search_text(left(text, 100000)))`,
    ),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    fileTextSource.check('file_text'),
    check('file_text_text_chk', sql`char_length(text) <= 200000`),
    foreignKey({
      name: 'file_text_file_fk',
      columns: [t.locationId, t.fileId],
      foreignColumns: [files.locationId, files.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('file_text_tsv_idx').using('gin', t.tsv),
    index('file_text_location_idx').on(t.locationId),
  ],
);
