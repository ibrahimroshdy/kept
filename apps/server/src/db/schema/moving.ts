import { BOX_STATES, MAX_MOVE_BOXES, MAX_MOVE_NAME, MOVE_STATUSES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
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
import { places } from './places.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Moving mode (1.x, D39 (5), D251). A move belongs to the location being packed (`location_id`,
// the engineering spec's `from_location_id`), and may name the location it is going to
// (`to_location_id`; null for a move within the same location). Its boxes are ordinary Kept
// containers, each with a number in the move, the room it goes to and its state: packed, in
// transit, unpacked. Unpacking moves the container, and with it everything inside, into its room
// through the ordinary move (D45), so the box row only records where the box is in the move.
//
// A box row lives in the move's location for row-level security; its container may leave that
// location when it is unpacked at the other end, so `container_id` and `destination_place_id`
// are plain foreign keys (purging the container takes its box row with it; a deleted room clears
// the box's destination).

const status = textEnum('status', MOVE_STATUSES);
const state = textEnum('state', BOX_STATES);

export const moves = pgTable(
  'moves',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    /** Where it is going; null when the boxes stay in this location. */
    toLocationId: uuid('to_location_id').references(() => locations.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    status: status.col().notNull().default('active'),
    createdBy: uuid('created_by').notNull(),
    /** Set with `status = 'done'`, cleared when it is opened again. */
    finishedAt: tstz('finished_at'),
    ...mutable(),
  },
  (t) => [
    status.check('moves'),
    check(
      'moves_name_chk',
      sql`char_length(btrim(name)) BETWEEN 1 AND ${sql.raw(String(MAX_MOVE_NAME))}`,
    ),
    check('moves_finished_chk', sql`(status = 'done') = (finished_at IS NOT NULL)`),
    unique('moves_location_id_uq').on(t.locationId, t.id),
    index('moves_location_idx').on(t.locationId, t.status),
    index('moves_to_location_idx').on(t.toLocationId),
  ],
);

export const moveBoxes = pgTable(
  'move_boxes',
  {
    locationId: uuid('location_id').notNull(),
    moveId: uuid('move_id').notNull(),
    containerId: uuid('container_id')
      .notNull()
      .references(() => things.id, { onDelete: 'cascade' }),
    /** Its number in the move: "Box 7". */
    number: integer('number').notNull(),
    state: state.col().notNull().default('packed'),
    /** The room it goes to, in the destination; null until someone chooses. */
    destinationPlaceId: uuid('destination_place_id').references(() => places.id, {
      onDelete: 'set null',
    }),
    /** When the state last changed (an offline change's time on the phone, D112): an older
     * change arriving later doesn't overwrite a newer one. */
    stateAt: tstz('state_at').notNull().defaultNow(),
    stateBy: uuid('state_by'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    state.check('move_boxes'),
    primaryKey({ name: 'move_boxes_pk', columns: [t.moveId, t.containerId] }),
    foreignKey({
      name: 'move_boxes_move_fk',
      columns: [t.locationId, t.moveId],
      foreignColumns: [moves.locationId, moves.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    unique('move_boxes_number_uq').on(t.moveId, t.number),
    check('move_boxes_number_chk', sql`number BETWEEN 1 AND ${sql.raw(String(MAX_MOVE_BOXES))}`),
    index('move_boxes_container_idx').on(t.containerId),
    index('move_boxes_destination_idx').on(t.destinationPlaceId),
  ],
);
