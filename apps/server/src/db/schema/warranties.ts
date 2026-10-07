import { CLAIM_STATUSES, WARRANTY_KINDS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum } from './common.js';
import { currencies } from './currencies.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Warranties and claims (step-4 plan T5; engineering spec §1.7, §7.13; D53–D55, D158, D195; plan
// Q18, Q26). Row-level security, the vendor guard, the claim transitions, the quantity rule (D10)
// and the thing's state bump are in the custom migration that follows (0051); see
// src/db/household-records.test.ts.

const warrantyKind = textEnum('kind', WARRANTY_KINDS);
const claimStatus = textEnum('status', CLAIM_STATUSES);

/**
 * One warranty on a thing, by kind (D53): an end date, a term in months, or lifetime, exactly one.
 * `effective_ends_on` is the last day covered, inclusive (L2): the SQL twin of @kept/shared
 * `warrantyEnds()` (a term ends the day before the same day `term_months` later; Postgres'
 * `date + interval` clamps the month's end as `addMonthsClamped()` does). A thing with a warranty
 * has quantity 1 (D10, 0051).
 */
export const warranties = pgTable(
  'warranties',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id').notNull(),
    kind: warrantyKind.col().notNull(),
    provider: text('provider'),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    termMonths: integer('term_months'),
    lifetime: boolean('lifetime').notNull().default(false),
    effectiveEndsOn: date('effective_ends_on').generatedAlwaysAs(
      sql`CASE WHEN lifetime THEN NULL
               WHEN ends_on IS NOT NULL THEN ends_on
               ELSE (starts_on + make_interval(months => term_months))::date - 1 END`,
    ),
    leadDays: integer('lead_days').notNull().default(30),
    claimContact: text('claim_contact'),
    registered: boolean('registered').notNull().default(false),
    registrationDeadline: date('registration_deadline'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    warrantyKind.check('warranties'),
    unique('warranties_location_id_uq').on(t.locationId, t.id),
    check('warranties_provider_chk', sql`char_length(provider) <= 120`),
    check('warranties_term_months_chk', sql`term_months BETWEEN 1 AND 600`),
    check('warranties_lead_days_chk', sql`lead_days BETWEEN 0 AND 365`),
    check('warranties_claim_contact_chk', sql`char_length(claim_contact) <= 300`),
    check('warranties_term_chk', sql`num_nonnulls(ends_on, term_months) + lifetime::int = 1`),
    check('warranties_ends_chk', sql`ends_on IS NULL OR ends_on >= starts_on`),
    foreignKey({
      name: 'warranties_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('warranties_thing_idx').on(t.thingId),
    index('warranties_ends_idx').on(t.effectiveEndsOn),
  ],
);

/**
 * A claim or repair (D54, D158, D195): `in_repair` makes the thing read "at <service centre>"
 * (the vendor), at most one at a time per thing. Status moves by `CLAIM_TRANSITIONS` (a trigger,
 * 0051); a closed claim reopens only through undo (Q18). `covered_amount` is "what it would have
 * cost" (Q18). The warranty and incident keys are ON DELETE SET NULL (col), in 0051.
 */
export const claims = pgTable(
  'claims',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id').notNull(),
    warrantyId: uuid('warranty_id'),
    incidentId: uuid('incident_id'),
    openedOn: date('opened_on').notNull(),
    reference: text('reference'),
    /** The service centre or shop: the account's vendor registry (D11), guarded in 0051. */
    vendorId: uuid('vendor_id'),
    status: claimStatus.col().notNull().default('open'),
    cost: numeric('cost', { precision: 16, scale: 4 }),
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    coveredAmount: numeric('covered_amount', { precision: 16, scale: 4 }),
    notes: text('notes'),
    closedOn: date('closed_on'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    claimStatus.check('claims'),
    unique('claims_location_id_uq').on(t.locationId, t.id),
    check('claims_reference_chk', sql`char_length(reference) <= 100`),
    check('claims_cost_chk', sql`cost >= 0`),
    check('claims_covered_amount_chk', sql`covered_amount >= 0`),
    check('claims_notes_chk', sql`char_length(notes) <= 5000`),
    check(
      'claims_money_chk',
      sql`(cost IS NULL AND covered_amount IS NULL) OR currency IS NOT NULL`,
    ),
    check('claims_closed_chk', sql`(status IN ('resolved', 'rejected')) = (closed_on IS NOT NULL)`),
    check('claims_closed_on_chk', sql`closed_on IS NULL OR closed_on >= opened_on`),
    foreignKey({
      name: 'claims_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    uniqueIndex('claims_one_repair_uq').on(t.thingId).where(sql`status = 'in_repair'`),
    index('claims_thing_idx').on(t.thingId),
    index('claims_warranty_idx').on(t.warrantyId),
    index('claims_incident_idx').on(t.incidentId),
    index('claims_vendor_idx').on(t.vendorId),
  ],
);
