import {
  type ConditionReportKind,
  type Digits,
  MAX_CONDITION_PDF_PHOTOS,
  pairRooms,
  type RoomCondition,
} from '@kept/shared';
import type pg from 'pg';
import { notFound } from '../../http/errors.js';
import type { ReportLocale } from '../labels.js';

// What a condition report's PDF holds (1.x, D235), read in the requester's scope: the `report`
// job runs as a tenant job inside withScope() on kept_app, so row-level security decides what it
// can see, as for a request. One report, or two of the same location side by side (a move-in and
// a move-out), the earlier walk-through first, their rooms paired by place and then by name
// (@kept/shared pairRooms).
//
// Photos are the 1200 px share derivative (GPS-stripped, D117; the display or the thumbnail when
// it has none), never the original. At most MAX_CONDITION_PDF_PHOTOS print, in the rooms' order;
// past that, and for a photo with no derivative (a HEIC Kept can't preview yet, D36), the room
// says how many more are in Kept.

export type ConditionReportOptions = {
  kind: 'condition';
  reportId: string;
  /** Another report of the same location, printed beside this one. */
  compareWith: string | null;
  include: { photos: boolean };
  locale: ReportLocale;
  digits: Digits;
};

export type GatheredPhoto = {
  /** The attachment's id: the photo's file name in the job directory. */
  id: string;
  key: string;
  addedAt: Date;
  by: string | null;
};

export type GatheredRoom = {
  id: string;
  placeId: string | null;
  name: string;
  condition: RoomCondition | null;
  note: string | null;
  photos: GatheredPhoto[];
  /** Photos in Kept this PDF leaves out (the cap, or no image to print). */
  morePhotos: number;
};

export type GatheredSide = {
  id: string;
  kind: ConditionReportKind;
  heldOn: string;
  notes: string | null;
  createdBy: string;
  finishedAt: Date | null;
  finishedBy: string | null;
  rooms: GatheredRoom[];
};

export type GatheredCondition = {
  locationName: string;
  locationTimezone: string;
  requesterName: string;
  requesterTimezone: string;
  /** One or two reports, the earlier walk-through first. */
  sides: GatheredSide[];
  /** Rooms side by side: `a` the first side's, `b` the second's (always null with one side). */
  pairs: { a: GatheredRoom | null; b: GatheredRoom | null }[];
};

type SideRow = {
  id: string;
  location_id: string;
  kind: ConditionReportKind;
  held_on: string;
  notes: string | null;
  created_by_name: string | null;
  finished_at: Date | null;
  finished_by_name: string | null;
  created_at: Date;
};

async function readSide(client: pg.ClientBase, id: string): Promise<SideRow | null> {
  const { rows } = await client.query<SideRow>(
    `SELECT r.id, r.location_id, r.kind, r.held_on::text AS held_on, r.notes, r.finished_at,
            r.created_at,
            (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = r.created_by)
              AS created_by_name,
            (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = r.finished_by)
              AS finished_by_name
       FROM public.condition_reports r WHERE r.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

type RoomRow = {
  id: string;
  report_id: string;
  place_id: string | null;
  name: string;
  condition: RoomCondition | null;
  note: string | null;
};

type PhotoRow = {
  id: string;
  room_id: string;
  created_at: Date;
  by: string | null;
  key: string | null;
};

/** Everything the PDF prints, as the requester may see it. 404 for a report they can't see, or
 * a comparison with a report of another location. */
export async function gatherCondition(
  client: pg.ClientBase,
  options: ConditionReportOptions,
): Promise<GatheredCondition> {
  const main = await readSide(client, options.reportId);
  if (!main) throw notFound();
  const other = options.compareWith ? await readSide(client, options.compareWith) : null;
  if (options.compareWith && (!other || other.location_id !== main.location_id)) throw notFound();
  const ordered = [main, ...(other ? [other] : [])].sort(
    (x, y) => x.held_on.localeCompare(y.held_on) || x.created_at.getTime() - y.created_at.getTime(),
  );
  const ids = ordered.map((s) => s.id);

  const { rows: rooms } = await client.query<RoomRow>(
    `SELECT id, report_id, place_id, name, condition, note FROM public.condition_report_rooms
      WHERE report_id = ANY ($1::uuid[]) ORDER BY sort, created_at, id`,
    [ids],
  );
  const { rows: photos } = await client.query<PhotoRow>(
    `SELECT a.id, a.condition_room_id AS room_id, a.created_at,
            (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = a.created_by)
              AS by,
            (SELECT d.storage_key FROM public.file_derivatives d
              WHERE d.file_id = a.file_id AND d.variant IN ('share', 'display', 'thumb')
              ORDER BY array_position(ARRAY['share', 'display', 'thumb'], d.variant::text)
              LIMIT 1) AS key
       FROM public.attachments a
       JOIN public.condition_report_rooms rm ON rm.id = a.condition_room_id
      WHERE rm.report_id = ANY ($1::uuid[]) AND a.file_id IS NOT NULL
      ORDER BY a.condition_room_id, a.sort, a.created_at, a.id`,
    [ids],
  );
  const byRoom = new Map<string, PhotoRow[]>();
  for (const p of photos) {
    const list = byRoom.get(p.room_id) ?? [];
    list.push(p);
    byRoom.set(p.room_id, list);
  }

  const sides: GatheredSide[] = ordered.map((s) => ({
    id: s.id,
    kind: s.kind,
    heldOn: s.held_on,
    notes: s.notes,
    createdBy: s.created_by_name ?? '',
    finishedAt: s.finished_at,
    finishedBy: s.finished_at ? (s.finished_by_name ?? '') : null,
    rooms: rooms
      .filter((r) => r.report_id === s.id)
      .map((r) => ({
        id: r.id,
        placeId: r.place_id,
        name: r.name,
        condition: r.condition,
        note: r.note,
        photos: [],
        morePhotos: 0,
      })),
  }));
  const [first, second] = sides as [GatheredSide, GatheredSide | undefined];
  const pairs = pairRooms(first.rooms, second?.rooms ?? []);

  // The photos, in the order the PDF prints them, up to the cap.
  let budget = options.include.photos ? MAX_CONDITION_PDF_PHOTOS : 0;
  for (const pair of pairs) {
    for (const room of [pair.a, pair.b]) {
      if (!room) continue;
      for (const p of byRoom.get(room.id) ?? []) {
        if (p.key && budget > 0) {
          room.photos.push({ id: p.id, key: p.key, addedAt: p.created_at, by: p.by });
          budget -= 1;
        } else {
          room.morePhotos += 1;
        }
      }
    }
  }

  const { rows: loc } = await client.query<{ name: string; timezone: string }>(
    'SELECT name, timezone FROM public.locations WHERE id = $1',
    [main.location_id],
  );
  const { rows: me } = await client.query<{ display_name: string; timezone: string }>(
    'SELECT display_name, timezone FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  return {
    locationName: loc[0]?.name ?? '',
    locationTimezone: loc[0]?.timezone ?? 'UTC',
    requesterName: me[0]?.display_name ?? '',
    requesterTimezone: me[0]?.timezone ?? 'UTC',
    sides,
    pairs,
  };
}
