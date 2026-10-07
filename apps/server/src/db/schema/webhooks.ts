import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_DISABLED_REASONS, WEBHOOK_EVENTS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';

// Outbound webhooks per location (step-6 plan T7; engineering spec §1.10, §2.6, §3.1b; D63, D110,
// D172, D180; plan Q18). A hook's signing secret is sealed (§7.3: table 'webhooks', row id, field
// 'secret'; its key version in `key_version`, as every sealed column, so rotate-key finds it) and
// write-only: kept_app can't SELECT it, the delivery job opens it through
// kept.webhook_secret(). Payloads carry ids and field names only (@kept/shared webhooks.ts).
// Row-level security, the system job policies and the doors are in the custom migration that
// follows (0078); see src/db/webhooks.test.ts.

const disabledReason = textEnum('disabled_reason', WEBHOOK_DISABLED_REASONS);
const deliveryStatus = textEnum('status', WEBHOOK_DELIVERY_STATUSES);
const eventList = sql.raw(WEBHOOK_EVENTS.map((e) => `'${e}'`).join(', '));

/** A location's webhook: its URL, the events it takes, and whether it is on (D180: it stops when
 * its creator stops administering the location). */
export const webhooks = pgTable(
  'webhooks',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secretCiphertext: jsonb('secret_ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    events: text('events').array().notNull(),
    active: boolean('active').notNull().default(true),
    failingSince: tstz('failing_since'),
    disabledReason: disabledReason.col(),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    disabledReason.check('webhooks'),
    unique('webhooks_location_id_uq').on(t.locationId, t.id),
    check('webhooks_url_chk', sql`url ~ '^https?://' AND char_length(url) <= 500`),
    check(
      'webhooks_events_chk',
      sql`cardinality(events) BETWEEN 1 AND 8 AND events <@ ARRAY[${eventList}]::text[]`,
    ),
    check('webhooks_key_version_chk', sql`key_version >= 1`),
    check('webhooks_disabled_chk', sql`active OR disabled_reason IS NOT NULL`),
    index('webhooks_location_idx').on(t.locationId),
  ],
);

/** One event's delivery to one hook (§3.1b): 10 attempts over 24 hours, then `gave_up`. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    webhookId: uuid('webhook_id').notNull(),
    eventId: text('event_id').notNull(),
    event: text('event').notNull(),
    status: deliveryStatus.col().notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    httpStatus: smallint('http_status'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    deliveryStatus.check('webhook_deliveries'),
    check('webhook_deliveries_event_id_chk', sql`event_id ~ '^evt_[A-Za-z0-9]{10,40}$'`),
    check('webhook_deliveries_event_chk', sql`event IN (${eventList}, 'ping')`),
    check('webhook_deliveries_attempts_chk', sql`attempts BETWEEN 0 AND 50`),
    check('webhook_deliveries_http_status_chk', sql`http_status BETWEEN 100 AND 599`),
    foreignKey({
      name: 'webhook_deliveries_webhook_fk',
      columns: [t.locationId, t.webhookId],
      foreignColumns: [webhooks.locationId, webhooks.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // One delivery of an event per hook: a retried fan-out adds nothing.
    unique('webhook_deliveries_event_uq').on(t.webhookId, t.eventId),
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
    index('webhook_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`status IN ('pending', 'failed')`),
    index('webhook_deliveries_location_idx').on(t.locationId),
  ],
);
