import { ATTACHMENT_ROLES, FILE_CLASSES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { fuelEntries } from './fuel.js';
import { loans } from './lending.js';
import { meterReadings } from './meters.js';
import { incidents, valuations } from './money.js';
import { places } from './places.js';
import { purchases } from './purchases.js';
import { expiringDocuments } from './schedules.js';
import { serviceRecords } from './services.js';
import { locations } from './tenancy.js';
import { things } from './things.js';
import { claims, warranties } from './warranties.js';

// Files, derivatives and attachments (engineering spec §1.5, §7.2, §7.13; D117, D155, D157, D161,
// D162, D177). A file is a stored original, kept byte-identical (D117) and deduplicated per
// location by SHA-256; it is readable only through an attachment the user can see, or as its
// uploader before it is attached (§7.2). Blobs are addressed by ids only (storage keys) and may be
// shared by the copies a cross-account move makes (D161). Row-level security and the definers
// are in the custom migration that follows (0020); see src/db/files.test.ts.

const fileClass = textEnum('class', FILE_CLASSES);
export const DERIVATIVE_STATES = ['ready', 'unavailable', 'not_applicable'] as const;
const derivativeState = textEnum('derivative_state', DERIVATIVE_STATES);
export const DERIVATIVE_VARIANTS = ['display', 'thumb', 'share', 'poster'] as const;
const derivativeVariant = textEnum('variant', DERIVATIVE_VARIANTS);
const attachmentRole = textEnum('role', ATTACHMENT_ROLES);

/** Append-only: a file is never edited, only attached, detached, copied or purged. */
export const files = pgTable(
  'files',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    /** `f/<locationId>/<fileId>` when uploaded; a copy keeps its source's key (D161). */
    storageKey: text('storage_key').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    /** Sniffed from the content, never the declared type (D157). */
    mime: text('mime').notNull(),
    class: fileClass.col().notNull(),
    hasGps: boolean('has_gps').notNull().default(false),
    width: integer('width'),
    height: integer('height'),
    derivativeState: derivativeState.col().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    fileClass.check('files'),
    derivativeState.check('files'),
    // Dedupe per location (D177): the same bytes uploaded twice are one file.
    unique('files_location_sha_uq').on(t.locationId, t.sha256),
    unique('files_location_id_uq').on(t.locationId, t.id),
    check('files_sha256_chk', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check('files_bytes_chk', sql`bytes > 0`),
    check('files_storage_key_chk', sql`char_length(storage_key) BETWEEN 1 AND 300`),
    check('files_mime_chk', sql`char_length(mime) BETWEEN 1 AND 100`),
    check('files_size_chk', sql`(width IS NULL OR width > 0) AND (height IS NULL OR height > 0)`),
    // Blobs shared by copies (D161): the purge checks what still references a key.
    index('files_storage_key_idx').on(t.storageKey),
    // kept.purge_orphan_files() walks old files in (created_at, id) order: no sort. "Has no
    // attachment" can't be indexed (another table), so the anti-join probes attachments_file_idx.
    index('files_unattached_idx').on(t.createdAt, t.id),
  ],
);

/** Display, thumbnail, share and poster renditions: GPS stripped, rotation baked in (D117). */
export const fileDerivatives = pgTable(
  'file_derivatives',
  {
    fileId: uuid('file_id').notNull(),
    variant: derivativeVariant.col().notNull(),
    locationId: uuid('location_id').notNull(),
    /** `d/<fileId>/<variant>.jpg`; a copy keeps its source's. */
    storageKey: text('storage_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
  },
  (t) => [
    derivativeVariant.check('file_derivatives'),
    primaryKey({ name: 'file_derivatives_pk', columns: [t.fileId, t.variant] }),
    foreignKey({
      name: 'file_derivatives_file_fk',
      columns: [t.locationId, t.fileId],
      foreignColumns: [files.locationId, files.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('file_derivatives_size_chk', sql`width > 0 AND height > 0 AND bytes > 0`),
    index('file_derivatives_storage_key_idx').on(t.storageKey),
  ],
);

/**
 * A file or a link attached to one subject, typed (§7.13): a thing, a place, a purchase, a meter
 * reading, or (step 4) a warranty, claim, loan, incident, valuation, service record or expiring
 * document, or (step 5) a fuel entry; none means
 * the location itself (D155). The file foreign key is DEFERRABLE (in
 * 0020), so a cross-location move can re-home files within one transaction.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id'),
    url: text('url'),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    purchaseId: uuid('purchase_id'),
    meterReadingId: uuid('meter_reading_id'),
    warrantyId: uuid('warranty_id'),
    claimId: uuid('claim_id'),
    loanId: uuid('loan_id'),
    incidentId: uuid('incident_id'),
    valuationId: uuid('valuation_id'),
    serviceRecordId: uuid('service_record_id'),
    expiringDocumentId: uuid('expiring_document_id'),
    /** Step 5: a fill's pump receipt (role `receipt`). */
    fuelEntryId: uuid('fuel_entry_id'),
    role: attachmentRole.col().notNull(),
    sort: integer('sort').notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    attachmentRole.check('attachments'),
    check('attachments_file_or_url_chk', sql`num_nonnulls(file_id, url) = 1`),
    check(
      'attachments_one_subject_chk',
      sql`num_nonnulls(thing_id, place_id, purchase_id, meter_reading_id, warranty_id, claim_id,
                       loan_id, incident_id, valuation_id, service_record_id,
                       expiring_document_id, fuel_entry_id) <= 1`,
    ),
    check(
      'attachments_url_chk',
      sql`url IS NULL OR (url ~ '^https?://' AND char_length(url) <= 2000)`,
    ),
    foreignKey({
      name: 'attachments_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'attachments_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'attachments_purchase_fk',
      columns: [t.locationId, t.purchaseId],
      foreignColumns: [purchases.locationId, purchases.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'attachments_meter_reading_fk',
      columns: [t.locationId, t.meterReadingId],
      foreignColumns: [meterReadings.locationId, meterReadings.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    ...(
      [
        ['warranty', t.warrantyId, warranties],
        ['claim', t.claimId, claims],
        ['loan', t.loanId, loans],
        ['incident', t.incidentId, incidents],
        ['valuation', t.valuationId, valuations],
        ['service_record', t.serviceRecordId, serviceRecords],
        ['expiring_document', t.expiringDocumentId, expiringDocuments],
        ['fuel_entry', t.fuelEntryId, fuelEntries],
      ] as const
    ).flatMap(([name, column, parent]) => [
      foreignKey({
        name: `attachments_${name}_fk`,
        columns: [t.locationId, column],
        foreignColumns: [parent.locationId, parent.id],
      })
        .onUpdate('cascade')
        .onDelete('cascade'),
      index(`attachments_${name}_idx`).on(column),
    ]),
    index('attachments_file_idx').on(t.fileId),
    index('attachments_thing_idx').on(t.thingId),
    index('attachments_place_idx').on(t.placeId),
    index('attachments_purchase_idx').on(t.purchaseId),
    index('attachments_meter_reading_idx').on(t.meterReadingId),
    index('attachments_location_idx').on(t.locationId),
    // Children of an attachment (step 3's extractions) point at (location_id, id).
    unique('attachments_location_id_uq').on(t.locationId, t.id),
  ],
);
