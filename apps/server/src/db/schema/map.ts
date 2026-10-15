import { MAP_ROOM_KINDS, MAP_SURFACES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, textEnum, tstz } from './common.js';
import { places } from './places.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// The location map's layout (1.x, D237): one row per room, place or thing someone arranged. A
// room or place nobody arranged has no row, and the web lays it out itself (rooms side by side in
// the tree's order, their contents in a grid), so the map is useful before anyone arranges it.
// Which floor a room is on, and which room a node stands in, come from the place tree, never from
// here: a thing moved in Kept moves on the map. Positions are whole centimetres from the floor's
// corner (rooms) or the room's corner (everything in a room). PUT /api/v1/locations/:id/layout
// replaces a location's rows in one arrange session. Row-level security is in the custom
// migration that follows; see src/map/map.test.ts.

const roomKind = textEnum('room_kind', MAP_ROOM_KINDS);
const surface = textEnum('surface', MAP_SURFACES);

export const mapNodes = pgTable(
  'map_nodes',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    /** A room (a place on a floor) or a place shown in a room: exactly one of the two. */
    placeId: uuid('place_id'),
    thingId: uuid('thing_id'),
    x: integer('x_cm').notNull(),
    z: integer('z_cm').notNull(),
    /** A room's size; null for everything else (its model has one). */
    w: integer('w_cm'),
    d: integer('d_cm'),
    /** A quarter turn, clockwise seen from above. */
    rot: integer('rot').notNull().default(0),
    /** The MAP_MODELS key (@kept/shared); null for a room, or to keep the guessed one. */
    model: text('model'),
    roomKind: roomKind.col(),
    surface: surface.col(),
    /** The place or thing this one stands on (a counter, a shelf, a box); the map's own fact,
     * not where Kept says it is. */
    hostId: uuid('host_id'),
    createdBy: uuid('created_by'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    roomKind.check('map_nodes'),
    surface.check('map_nodes'),
    check('map_nodes_one_subject_chk', sql`num_nonnulls(place_id, thing_id) = 1`),
    check('map_nodes_rot_chk', sql`rot IN (0, 90, 180, 270)`),
    check('map_nodes_xz_chk', sql`x_cm BETWEEN 0 AND 100000 AND z_cm BETWEEN 0 AND 100000`),
    check(
      'map_nodes_size_chk',
      sql`(w_cm IS NULL AND d_cm IS NULL) OR (w_cm BETWEEN 100 AND 10000 AND d_cm BETWEEN 100 AND 10000)`,
    ),
    check('map_nodes_model_chk', sql`model IS NULL OR model ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check('map_nodes_room_chk', sql`(room_kind IS NULL AND surface IS NULL) OR w_cm IS NOT NULL`),
    check(
      'map_nodes_not_own_host_chk',
      sql`host_id IS NULL OR host_id <> coalesce(place_id, thing_id)`,
    ),
    foreignKey({
      name: 'map_nodes_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'map_nodes_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    uniqueIndex('map_nodes_place_uq').on(t.placeId),
    uniqueIndex('map_nodes_thing_uq').on(t.thingId),
    index('map_nodes_location_idx').on(t.locationId),
  ],
);
