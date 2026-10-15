import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { attachments } from './files.js';
import { places } from './places.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Paperless-ngx (1.x, D248): a location's connection to a Paperless-ngx server, and the links from
// a thing or a place to documents there. A link is not a copy: it stores the document's id and a
// small cache (title, kind, type, correspondent, date) so the thing page shows something when
// Paperless is down. "Copy into Kept" makes an ordinary attachment and records it on the link.
//
// The connection's URL and API token are sealed together (§7.3: table 'paperless_connections', row
// id, field 'config'; key version in `key_version`, so rotate-key finds it) and kept_app never
// reads them: the server opens them through kept.paperless_config() after checking the caller's
// access. `base_url` is kept in the clear too, for the settings page and "Open in Paperless".
// Row-level security, the door and the trigger that drops a moved thing's links are in the custom
// migration that follows; see src/paperless/paperless.test.ts.

/** What a linked document is, in Kept's attachment roles (the ones the paperwork library lists). */
export const PAPERLESS_KINDS = [
  'receipt',
  'invoice',
  'manual',
  'warranty_doc',
  'document',
] as const;
export type PaperlessKind = (typeof PAPERLESS_KINDS)[number];

const kind = textEnum('kind', PAPERLESS_KINDS);

/** One per location (D248): the Paperless server, its version when last saved, and who connected it. */
export const paperlessConnections = pgTable(
  'paperless_connections',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    /** The server's root as saved (no token, no query), e.g. `https://paperless.example.com`. */
    baseUrl: text('base_url').notNull(),
    configCiphertext: jsonb('config_ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** Paperless's `X-Version` when the connection was last saved or tested. */
    serverVersion: text('server_version'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    unique('paperless_connections_location_uq').on(t.locationId),
    unique('paperless_connections_location_id_uq').on(t.locationId, t.id),
    check('paperless_connections_base_url_chk', sql`char_length(base_url) BETWEEN 1 AND 500`),
    check('paperless_connections_key_version_chk', sql`key_version >= 1`),
    check(
      'paperless_connections_version_chk',
      sql`server_version IS NULL OR char_length(server_version) <= 40`,
    ),
  ],
);

/** A thing's or a place's link to one Paperless document (D248). */
export const paperlessLinks = pgTable(
  'paperless_links',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    thingId: uuid('thing_id').references(() => things.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id').references(() => places.id, { onDelete: 'cascade' }),
    /** The document's id in Paperless. */
    documentId: integer('document_id').notNull(),
    /** The cache, refreshed when linked, copied or opened in the picker again. */
    title: text('title').notNull(),
    kind: kind.col().notNull(),
    typeName: text('type_name'),
    correspondent: text('correspondent'),
    createdOn: date('created_on', { mode: 'string' }),
    /** The attachment "Copy into Kept" made; null when never copied, or when it was removed. */
    copiedAttachmentId: uuid('copied_attachment_id').references(() => attachments.id, {
      onDelete: 'set null',
    }),
    refreshedAt: tstz('refreshed_at').notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    kind.check('paperless_links'),
    foreignKey({
      name: 'paperless_links_connection_fk',
      columns: [t.locationId, t.connectionId],
      foreignColumns: [paperlessConnections.locationId, paperlessConnections.id],
    }).onDelete('cascade'),
    check('paperless_links_subject_chk', sql`num_nonnulls(thing_id, place_id) = 1`),
    check('paperless_links_document_chk', sql`document_id > 0`),
    check('paperless_links_title_chk', sql`char_length(title) BETWEEN 1 AND 300`),
    check('paperless_links_type_chk', sql`type_name IS NULL OR char_length(type_name) <= 128`),
    check(
      'paperless_links_correspondent_chk',
      sql`correspondent IS NULL OR char_length(correspondent) <= 128`,
    ),
    unique('paperless_links_thing_uq').on(t.thingId, t.documentId),
    unique('paperless_links_place_uq').on(t.placeId, t.documentId),
    index('paperless_links_location_idx').on(t.locationId),
    index('paperless_links_copied_idx').on(t.copiedAttachmentId),
  ],
);
