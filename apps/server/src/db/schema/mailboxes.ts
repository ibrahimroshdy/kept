import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
import { locations } from './tenancy.js';

// Email-in (1.4, D21, D231; engineering spec §1 `mailboxes`): a location's IMAP mailbox, which
// the `mail-in` job polls for receipts. Its connection (host, port, TLS, user name, password,
// folder) is sealed (§7.3: table 'mailboxes', row id, field 'config'; its key version in
// `key_version`, so rotate-key finds it) and write-only: kept_app can't SELECT it, the job opens
// it through kept.mailbox_config(). `host` and `username` are kept in the clear too, for the
// settings page. The forwarding address on the cloud (kind `cloud_address`) is the cloud phase's.
// Row-level security, the system job policies and the door are in the custom migration that
// follows; see src/mailin/mailin.test.ts.

export const MAILBOX_KINDS = ['imap'] as const;
/** What became of one message (mailbox_messages.outcome). */
export const MAIL_OUTCOMES = [
  'receipt',
  'no_receipt',
  'sender_not_allowed',
  'too_large',
  'failed',
] as const;
export const MAILBOX_DISABLED_REASONS = ['creator_left', 'auth_failed'] as const;

const kind = textEnum('kind', MAILBOX_KINDS);
const outcome = textEnum('outcome', MAIL_OUTCOMES);
const disabledReason = textEnum('disabled_reason', MAILBOX_DISABLED_REASONS);

/** One per location (D231): the mailbox, the folder it watches, and how far it has read. */
export const mailboxes = pgTable(
  'mailboxes',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: kind.col().notNull().default('imap'),
    host: text('host').notNull(),
    username: text('username').notNull(),
    folder: text('folder').notNull(),
    /** Only mail from these addresses is read; empty reads every sender (lower case). */
    allowedSenders: text('allowed_senders').array().notNull().default(sql`'{}'::text[]`),
    configCiphertext: jsonb('config_ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    active: boolean('active').notNull().default(true),
    disabledReason: disabledReason.col(),
    /** The folder's UIDVALIDITY and the last UID read; null until the first poll sets the mark. */
    uidValidity: bigint('uid_validity', { mode: 'number' }),
    lastUid: bigint('last_uid', { mode: 'number' }),
    lastPolledAt: tstz('last_polled_at'),
    lastError: text('last_error'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    kind.check('mailboxes'),
    disabledReason.check('mailboxes'),
    unique('mailboxes_location_uq').on(t.locationId),
    unique('mailboxes_location_id_uq').on(t.locationId, t.id),
    check('mailboxes_host_chk', sql`char_length(host) BETWEEN 1 AND 253`),
    check('mailboxes_username_chk', sql`char_length(username) BETWEEN 1 AND 254`),
    check('mailboxes_folder_chk', sql`char_length(folder) BETWEEN 1 AND 200`),
    check('mailboxes_senders_chk', sql`cardinality(allowed_senders) <= 20`),
    check('mailboxes_key_version_chk', sql`key_version >= 1`),
    check('mailboxes_disabled_chk', sql`active OR disabled_reason IS NOT NULL`),
    check('mailboxes_last_error_chk', sql`last_error IS NULL OR char_length(last_error) <= 32`),
  ],
);

/** One message the job read, and what it became: the page's "Recent mail", and no message twice. */
export const mailboxMessages = pgTable(
  'mailbox_messages',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    mailboxId: uuid('mailbox_id').notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
    uid: bigint('uid', { mode: 'number' }).notNull(),
    fromAddress: text('from_address'),
    subject: text('subject'),
    receivedAt: tstz('received_at'),
    outcome: outcome.col().notNull(),
    purchaseId: uuid('purchase_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    outcome.check('mailbox_messages'),
    foreignKey({
      name: 'mailbox_messages_mailbox_fk',
      columns: [t.locationId, t.mailboxId],
      foreignColumns: [mailboxes.locationId, mailboxes.id],
    }).onDelete('cascade'),
    unique('mailbox_messages_uid_uq').on(t.mailboxId, t.uidValidity, t.uid),
    check(
      'mailbox_messages_from_chk',
      sql`from_address IS NULL OR char_length(from_address) <= 254`,
    ),
    check('mailbox_messages_subject_chk', sql`subject IS NULL OR char_length(subject) <= 200`),
    index('mailbox_messages_recent_idx').on(t.mailboxId, t.createdAt),
  ],
);
