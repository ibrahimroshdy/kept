import {
  CHANNEL_KINDS_1_0,
  NOTIFY_KIND_SLOTS,
  NOTIFY_KINDS,
  PREFERENCE_CHANNELS,
} from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';

// Channels, push subscriptions, preferences and calendar feeds (step-4 plan T7; engineering spec
// §1.9, §7.3, §7.13; D29, D30, D130, D139, D142, D181; plan Q10–Q13, Q23, Q35). Each is its user's
// own. Row-level security, the caps and the calendar door are in 0055; see
// src/db/reminders.test.ts.

const channelKind = textEnum('kind', CHANNEL_KINDS_1_0);
const preferenceKind = textEnum('kind', NOTIFY_KINDS);
// The CHECK holds step 5's `reading_stale` slot before the kind is built (0067).
const preferenceKindSlots = textEnum('kind', NOTIFY_KIND_SLOTS);
const preferenceChannel = textEnum('channel', PREFERENCE_CHANNELS);

/**
 * Where a user's notices go (D30; Q13): one email channel (made lazily; managed accounts never
 * get one), one web-push channel (its devices are push_subscriptions), and up to 5 webhooks (a
 * trigger, 0055). A webhook's `{url, secret}` is sealed (§7.3: table 'notification_channels', row
 * id, field 'config'); kept_app can't SELECT it, only notify/webhook.ts on the system side opens
 * it. `display_host` is the URL's host, to show.
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: channelKind.col().notNull(),
    label: text('label'),
    displayHost: text('display_host'),
    configCiphertext: jsonb('config_ciphertext'),
    keyVersion: integer('key_version'),
    verifiedAt: tstz('verified_at'),
    failingSince: tstz('failing_since'),
    ...mutable(),
  },
  (t) => [
    channelKind.check('notification_channels'),
    check('notification_channels_label_chk', sql`char_length(label) <= 60`),
    check('notification_channels_display_host_chk', sql`char_length(display_host) <= 255`),
    check(
      'notification_channels_config_chk',
      sql`(kind = 'webhook') = (config_ciphertext IS NOT NULL)
          AND (config_ciphertext IS NULL) = (key_version IS NULL)`,
    ),
    uniqueIndex('notification_channels_email_uq').on(t.userId).where(sql`kind = 'email'`),
    uniqueIndex('notification_channels_webpush_uq').on(t.userId).where(sql`kind = 'webpush'`),
    index('notification_channels_user_idx').on(t.userId),
  ],
);

/** A browser's push subscription (D139, L112): removed when the push service answers 404/410. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    label: text('label'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSuccessAt: tstz('last_success_at'),
    failures: integer('failures').notNull().default(0),
  },
  (t) => [
    unique('push_subscriptions_endpoint_uq').on(t.endpoint),
    // Q12: HTTPS only; the sender also refuses private addresses at connect time.
    check(
      'push_subscriptions_endpoint_chk',
      sql`endpoint ~ '^https://' AND char_length(endpoint) <= 1000`,
    ),
    check(
      'push_subscriptions_keys_chk',
      sql`char_length(p256dh) <= 200 AND char_length(auth) <= 100`,
    ),
    check('push_subscriptions_label_chk', sql`char_length(label) <= 60`),
    check('push_subscriptions_failures_chk', sql`failures >= 0`),
    index('push_subscriptions_user_idx').on(t.userId),
  ],
);

/**
 * A choice a person made (D29; Q35): a row only where they chose; no row is @kept/shared
 * `defaultPreference()`, so a change to the defaults reaches everyone who never chose. The AI
 * monthly summary is account-level: its row has no location.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    kind: preferenceKind.col().notNull(),
    channel: preferenceChannel.col().notNull(),
    enabled: boolean('enabled').notNull(),
    ...mutable(),
  },
  (t) => [
    preferenceKindSlots.check('notification_preferences'),
    preferenceChannel.check('notification_preferences'),
    unique('notification_preferences_uq')
      .on(t.userId, t.locationId, t.kind, t.channel)
      .nullsNotDistinct(),
    check(
      'notification_preferences_account_chk',
      sql`(kind = 'ai_summary') = (location_id IS NULL)`,
    ),
    index('notification_preferences_location_idx').on(t.locationId),
  ],
);

/**
 * A calendar feed link (D142, D181): `/cal/<token>`, only its sha256 stored; at most 3 unrevoked
 * per user (a trigger, 0055). The public fetch goes through kept.calendar_feed_user().
 */
export const calendarFeeds = pgTable(
  'calendar_feeds',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    revokedAt: tstz('revoked_at'),
    lastFetchedAt: tstz('last_fetched_at'),
    fetches: integer('fetches').notNull().default(0),
  },
  (t) => [
    unique('calendar_feeds_token_hash_uq').on(t.tokenHash),
    check('calendar_feeds_token_hash_chk', sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check('calendar_feeds_fetches_chk', sql`fetches >= 0`),
    index('calendar_feeds_user_idx').on(t.userId),
  ],
);
