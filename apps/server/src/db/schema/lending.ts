import { LOAN_DIRECTIONS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Lending and borrowing (step-4 plan T5; engineering spec §1.7, §7.13; D56, D57, D119, D172; plan
// Q14–Q17). Row-level security, the person guard and the thing's state bump are in the custom
// migration that follows (0051); see src/db/household-records.test.ts.

const direction = textEnum('direction', LOAN_DIRECTIONS);

/**
 * A thing lent out to someone, or borrowed in from someone (D56): one open loan per thing
 * (§7.13). The person is the account's people registry (a member is a person with
 * `member_user_id`, Q16), guarded in 0051. `previous_*` say where it was, for "return to
 * previous": no foreign key, the place may be gone by the return (the route falls back to
 * Unplaced). `split_from_thing_id` is the row a partial lend split off (D172). The return-place
 * and split keys are ON DELETE SET NULL (col), in 0051.
 */
export const loans = pgTable(
  'loans',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id').notNull(),
    direction: direction.col().notNull(),
    personId: uuid('person_id').notNull(),
    startedAt: tstz('started_at').notNull(),
    dueOn: date('due_on'),
    returnedAt: tstz('returned_at'),
    returnPlaceId: uuid('return_place_id'),
    /** Where a lent thing came back into a container (step-4 UI review L7): the container, set
     * instead of `return_place_id`. ON DELETE SET NULL (col), in 0087. */
    returnContainerId: uuid('return_container_id'),
    previousPlaceId: uuid('previous_place_id'),
    previousContainerId: uuid('previous_container_id'),
    splitFromThingId: uuid('split_from_thing_id'),
    leadDays: integer('lead_days').notNull().default(0),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    direction.check('loans'),
    unique('loans_location_id_uq').on(t.locationId, t.id),
    check('loans_lead_days_chk', sql`lead_days BETWEEN 0 AND 60`),
    check('loans_notes_chk', sql`char_length(notes) <= 2000`),
    // "Due ≥ start" (screens §7) is the route's, in the location's zone; the table only refuses a
    // due date more than a day before the start (zone slack).
    check(
      'loans_due_chk',
      sql`due_on IS NULL OR due_on >= (started_at AT TIME ZONE 'UTC')::date - 1`,
    ),
    check('loans_returned_chk', sql`returned_at IS NULL OR returned_at >= started_at`),
    check('loans_return_where_chk', sql`num_nonnulls(return_place_id, return_container_id) <= 1`),
    foreignKey({
      name: 'loans_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    uniqueIndex('loans_one_open_uq').on(t.thingId).where(sql`returned_at IS NULL`),
    index('loans_due_idx').on(t.dueOn).where(sql`returned_at IS NULL`),
    index('loans_person_idx').on(t.personId),
    index('loans_thing_idx').on(t.thingId),
  ],
);
