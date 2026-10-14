import {
  CONDITION_REPORT_KINDS,
  MAX_CONDITION_NOTE,
  MAX_ROOM_NAME,
  ROOM_CONDITIONS,
} from '@kept/shared';
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

// Renters' condition reports (1.x, D171, D174; D235). A report is one walk-through of a location,
// move-in or move-out, on a day; its rooms are the location's rooms when it starts (places of the
// `room` kind), plus any added by hand, each with how it was found, a note, and photos (attachments
// on the room, `attachments.condition_room_id`). Finishing a report stamps who and when and locks
// it: the policies of the custom migration refuse every later change to it, its rooms and their
// photos, and so do the routes, with a reason.
//
// A room keeps its own name, copied from the place when it was added: renaming or deleting the
// place later doesn't rewrite a report someone may already have sent to a landlord. `place_id`
// only pairs it with the same room in another report, so it is not a foreign key: a place may be
// purged, or moved to another location, and the report stays as it was.

const kind = textEnum('kind', CONDITION_REPORT_KINDS);
const roomCondition = textEnum('condition', ROOM_CONDITIONS);

export const conditionReports = pgTable(
  'condition_reports',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: kind.col().notNull(),
    /** The day of the walk-through, in the location's calendar. */
    heldOn: date('held_on').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    /** Set together, once: the report is finished and locked. */
    finishedAt: tstz('finished_at'),
    finishedBy: uuid('finished_by'),
    ...mutable(),
  },
  (t) => [
    kind.check('condition_reports'),
    check(
      'condition_reports_notes_chk',
      sql`char_length(notes) <= ${sql.raw(String(MAX_CONDITION_NOTE))}`,
    ),
    check('condition_reports_finished_chk', sql`(finished_at IS NULL) = (finished_by IS NULL)`),
    unique('condition_reports_location_id_uq').on(t.locationId, t.id),
    index('condition_reports_location_idx').on(t.locationId, t.heldOn),
  ],
);

export const conditionReportRooms = pgTable(
  'condition_report_rooms',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    reportId: uuid('report_id').notNull(),
    /** The place it was taken from; null for a room added by name. */
    placeId: uuid('place_id'),
    name: text('name').notNull(),
    condition: roomCondition.col(),
    note: text('note'),
    sort: integer('sort').notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    roomCondition.check('condition_report_rooms'),
    check(
      'condition_report_rooms_name_chk',
      sql`char_length(btrim(name)) BETWEEN 1 AND ${sql.raw(String(MAX_ROOM_NAME))}`,
    ),
    check(
      'condition_report_rooms_note_chk',
      sql`char_length(note) <= ${sql.raw(String(MAX_CONDITION_NOTE))}`,
    ),
    foreignKey({
      name: 'condition_report_rooms_report_fk',
      columns: [t.locationId, t.reportId],
      foreignColumns: [conditionReports.locationId, conditionReports.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    unique('condition_report_rooms_location_id_uq').on(t.locationId, t.id),
    // A place is one room of a report.
    uniqueIndex('condition_report_rooms_place_uq')
      .on(t.reportId, t.placeId)
      .where(sql`place_id IS NOT NULL`),
    index('condition_report_rooms_report_idx').on(t.reportId, t.sort),
    index('condition_report_rooms_place_idx').on(t.placeId),
  ],
);
