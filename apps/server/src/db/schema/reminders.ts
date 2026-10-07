import {
  DELIVERY_STATUSES,
  NOTIFICATION_KINDS,
  OCCURRENCE_KINDS,
  OCCURRENCE_STATES,
  SOURCE_TYPES,
} from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, textEnum, tstz } from './common.js';
import { notificationChannels } from './notify.js';
import { places } from './places.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// The reminder ledger (step-4 plan T7; engineering spec §1.9, §7.13; D29, D111, D122, D188): the
// only stored reminder state. The agenda (public.agenda_items, 0053) says what is due; the scan
// writes each occurrence once and fans it out to deliveries, once per user and channel row. Both
// are the scan's bookkeeping: no row_version. Row-level security is in 0055; see
// src/db/reminders.test.ts.

const sourceType = textEnum('source_type', SOURCE_TYPES);
const occurrenceKind = textEnum('kind', OCCURRENCE_KINDS);
const occurrenceState = textEnum('state', OCCURRENCE_STATES);
const deliveryStatus = textEnum('status', DELIVERY_STATUSES);
const notificationKind = textEnum('kind', NOTIFICATION_KINDS);

/**
 * One occurrence of a source's due point (D111): unique on the §7.13 key, so two scans (or two
 * concurrent ones) write it once. `source_id` has no foreign key (six source tables): the scan
 * cancels an occurrence whose source is gone. Both subjects null: the location itself.
 */
export const reminderOccurrences = pgTable(
  'reminder_occurrences',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    sourceType: sourceType.col().notNull(),
    sourceId: uuid('source_id').notNull(),
    kind: occurrenceKind.col().notNull(),
    duePeriod: text('due_period').notNull(),
    dueOn: date('due_on'),
    state: occurrenceState.col().notNull().default('open'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    closedAt: tstz('closed_at'),
  },
  (t) => [
    sourceType.check('reminder_occurrences'),
    occurrenceKind.check('reminder_occurrences'),
    occurrenceState.check('reminder_occurrences'),
    unique('reminder_occurrences_location_id_uq').on(t.locationId, t.id),
    check(
      'reminder_occurrences_due_period_chk',
      sql`due_period ~ '^(date:\\d{4}-\\d{2}-\\d{2}|meter:\\d+(\\.\\d{1,3})?)$'`,
    ),
    check('reminder_occurrences_subject_chk', sql`num_nonnulls(thing_id, place_id) <= 1`),
    check('reminder_occurrences_closed_chk', sql`(state = 'open') = (closed_at IS NULL)`),
    foreignKey({
      name: 'reminder_occurrences_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'reminder_occurrences_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // §7.13's key: the scan's INSERT … ON CONFLICT DO NOTHING writes an occurrence once.
    unique('reminder_occurrences_key_uq')
      .on(t.thingId, t.placeId, t.locationId, t.sourceType, t.sourceId, t.kind, t.duePeriod)
      .nullsNotDistinct(),
    index('reminder_occurrences_open_idx').on(t.locationId).where(sql`state = 'open'`),
    index('reminder_occurrences_source_idx').on(t.sourceId),
  ],
);

/**
 * One delivery of an occurrence to one user on one channel row (§7.13: the channel references
 * notification_channels.id), exactly once. `digest` waits for the user's digest; `not_before`
 * holds an immediate one past their quiet hours. Append-only apart from its status.
 */
export const reminderDeliveries = pgTable(
  'reminder_deliveries',
  {
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => reminderOccurrences.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    status: deliveryStatus.col().notNull(),
    notBefore: tstz('not_before'),
    sentAt: tstz('sent_at'),
    /** A short machine code, never a message with data. */
    error: text('error'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    deliveryStatus.check('reminder_deliveries'),
    primaryKey({
      name: 'reminder_deliveries_pk',
      columns: [t.occurrenceId, t.userId, t.channelId],
    }),
    check('reminder_deliveries_error_chk', sql`error ~ '^[a-z_0-9]{1,40}$'`),
    index('reminder_deliveries_digest_idx').on(t.userId).where(sql`status = 'digest'`),
    index('reminder_deliveries_queued_idx').on(t.notBefore).where(sql`status = 'queued'`),
    index('reminder_deliveries_channel_idx').on(t.channelId),
  ],
);

/** One digest per user, local day and channel, exactly once (D29). */
export const notificationDigests = pgTable(
  'notification_digests',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    digestOn: date('digest_on').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    sentAt: tstz('sent_at'),
  },
  (t) => [
    primaryKey({
      name: 'notification_digests_pk',
      columns: [t.userId, t.digestOn, t.channelId],
    }),
    index('notification_digests_channel_idx').on(t.channelId),
  ],
);

/**
 * The in-app centre (D39; Q10): every enabled kind lands here, whatever the channels. `payload`
 * holds ids and codes only (the web renders the words): never money, a secret or a contact
 * detail. A reminder's notification is its user's once per occurrence, and invisible once the
 * user loses the location (0055).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    occurrenceId: uuid('occurrence_id').references(() => reminderOccurrences.id, {
      onDelete: 'cascade',
    }),
    kind: notificationKind.col().notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    readAt: tstz('read_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    notificationKind.check('notifications'),
    unique('notifications_user_occurrence_uq').on(t.userId, t.occurrenceId),
    check('notifications_payload_chk', sql`jsonb_typeof(payload) = 'object'`),
    check('notifications_reminder_chk', sql`(kind = 'reminder') = (occurrence_id IS NOT NULL)`),
    index('notifications_user_idx').on(t.userId, t.createdAt.desc()),
    index('notifications_unread_idx').on(t.userId).where(sql`read_at IS NULL`),
    index('notifications_occurrence_idx').on(t.occurrenceId),
  ],
);
