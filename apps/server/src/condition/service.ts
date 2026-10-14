import {
  CONDITION_REPORT_KINDS,
  type ConditionReportKind,
  MAX_CONDITION_NOTE,
  MAX_CONDITION_ROOMS,
  MAX_ROOM_NAME,
  MAX_ROOM_PHOTOS,
  ROOM_CONDITIONS,
  type RoomCondition,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  type AttachmentView,
  attachmentViews,
} from '../files/views.js';
import { assertClientId, checkVersion, pageOf } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import type { FileStorage } from '../storage/blob-store.js';

// Renters' condition reports (1.x, D171, D174; D235). A report is one walk-through of a location,
// move-in or move-out, on a day, room by room; each room has how it was found (good, fair, poor,
// damaged), a note and dated photos. The photos are ordinary attachments on the room (subject
// `conditionRoomId`, role `photo`), uploaded and stripped of location data like every photo
// (D117); the date beside each is when Kept received it, the server's clock, never the camera's.
//
// Who (D235): everyone who sees the location reads its reports, viewers included; writing one is
// `things.edit` (members and above), as recording the home's things is. Finishing a report locks
// it (the policies of 0125 and the photo trigger say the same); a finished report is deleted only
// by owners and admins. Every write runs as the request's user under row-level security and is
// audited: `condition_report.create|update|finish|delete`, `condition_room.create|update|delete`;
// photos are `attachment.create|delete`. None is undoable: a deleted draft is asked about first.
//
// Condition reports belong to no module: a location shows none until someone starts one, and the
// feature is reached from the location's page (D235).
//
// GET    /api/v1/condition-reports?locationId&kind&state&cursor&limit  → {items, next_cursor}
// GET    /api/v1/condition-reports/:id                                  → ConditionReport
// POST   /api/v1/locations/:id/condition-reports                        → 201 ConditionReport
// PATCH  /api/v1/condition-reports/:id (If-Match)                       → ConditionReport
// POST   /api/v1/condition-reports/:id/finish (If-Match)                → ConditionReport
// DELETE /api/v1/condition-reports/:id (If-Match)                       → 204
// POST   /api/v1/condition-reports/:id/rooms                            → 201 ConditionRoom
// PATCH  /api/v1/condition-rooms/:id (If-Match)                         → ConditionRoom
// DELETE /api/v1/condition-rooms/:id (If-Match)                         → 204

const Day = z.iso.date();
const Note = z.string().max(MAX_CONDITION_NOTE);
const Kind = z.enum(CONDITION_REPORT_KINDS);
const RoomName = z.string().trim().min(1).max(MAX_ROOM_NAME);

export const CreateReportBody = z
  .object({
    id: z.uuid().optional(),
    kind: Kind,
    heldOn: Day,
    notes: Note.optional(),
  })
  .strict();
export type CreateReportBody = z.infer<typeof CreateReportBody>;

export const UpdateReportBody = z
  .object({
    kind: Kind.optional(),
    heldOn: Day.optional(),
    notes: Note.nullable().optional(),
  })
  .strict();
export type UpdateReportBody = z.infer<typeof UpdateReportBody>;

export const CreateRoomBody = z
  .object({
    id: z.uuid().optional(),
    placeId: z.uuid().optional(),
    name: RoomName.optional(),
  })
  .strict()
  .refine((b) => b.placeId !== undefined || b.name !== undefined, {
    message: 'a place or a name',
    path: ['name'],
  });
export type CreateRoomBody = z.infer<typeof CreateRoomBody>;

export const UpdateRoomBody = z
  .object({
    name: RoomName.optional(),
    condition: z.enum(ROOM_CONDITIONS).nullable().optional(),
    note: Note.nullable().optional(),
    sort: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .strict();
export type UpdateRoomBody = z.infer<typeof UpdateRoomBody>;

export const ReportsQuery = z.object({
  locationId: z.uuid().optional(),
  kind: Kind.optional(),
  state: z.enum(['open', 'finished']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
});
export type ReportsQuery = z.infer<typeof ReportsQuery>;

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

type Person = { displayName: string };

export type ConditionReportRowView = {
  id: string;
  locationId: string;
  kind: ConditionReportKind;
  heldOn: string;
  notes: string | null;
  createdBy: Person;
  createdAt: string;
  finishedAt: string | null;
  finishedBy: Person | null;
  roomCount: number;
  photoCount: number;
  rowVersion: number;
};

/** A room's photo: the attachment, and when Kept received it. */
export type ConditionPhotoView = AttachmentView & { addedAt: string };

export type ConditionRoomView = {
  id: string;
  reportId: string;
  placeId: string | null;
  name: string;
  condition: RoomCondition | null;
  note: string | null;
  sort: number;
  photos: ConditionPhotoView[];
  rowVersion: number;
};

export type ConditionReportView = ConditionReportRowView & {
  /** The location's time zone: photo times and the finished time read in it. */
  timezone: string;
  rooms: ConditionRoomView[];
  /** The location's reports of the other kind, newest first: what this one compares with. */
  others: { id: string; kind: ConditionReportKind; heldOn: string; finishedAt: string | null }[];
};

type ReportRecord = {
  id: string;
  location_id: string;
  kind: ConditionReportKind;
  held_on: string;
  notes: string | null;
  created_by: string;
  created_at: Date;
  finished_at: Date | null;
  finished_by: string | null;
  row_version: number;
  created_name: string | null;
  finished_name: string | null;
  room_count: number;
  photo_count: number;
};

const REPORT_COLUMNS = `r.id, r.location_id, r.kind, r.held_on::text AS held_on, r.notes, r.created_by,
  r.created_at, r.finished_at, r.finished_by, r.row_version,
  (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = r.created_by)
    AS created_name,
  (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = r.finished_by)
    AS finished_name,
  (SELECT count(*) FROM public.condition_report_rooms rm WHERE rm.report_id = r.id)::int
    AS room_count,
  (SELECT count(*) FROM public.attachments a
     JOIN public.condition_report_rooms rm ON rm.id = a.condition_room_id
    WHERE rm.report_id = r.id)::int AS photo_count`;

const rowView = (r: ReportRecord): ConditionReportRowView => ({
  id: r.id,
  locationId: r.location_id,
  kind: r.kind,
  heldOn: r.held_on,
  notes: r.notes,
  createdBy: { displayName: r.created_name ?? '' },
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  finishedBy: r.finished_at ? { displayName: r.finished_name ?? '' } : null,
  roomCount: r.room_count,
  photoCount: r.photo_count,
  rowVersion: r.row_version,
});

/** The report as the caller sees it; null when invisible. */
export async function findReport(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<ReportRecord | null> {
  const { rows } = await client.query<ReportRecord>(
    `SELECT ${REPORT_COLUMNS} FROM public.condition_reports r
      WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`,
    [id.toLowerCase()],
  );
  return rows[0] ?? null;
}

type RoomRecord = {
  id: string;
  location_id: string;
  report_id: string;
  place_id: string | null;
  name: string;
  condition: RoomCondition | null;
  note: string | null;
  sort: number;
  created_by: string;
  row_version: number;
};

const ROOM_COLUMNS = `rm.id, rm.location_id, rm.report_id, rm.place_id, rm.name, rm.condition,
  rm.note, rm.sort, rm.created_by, rm.row_version`;

/** The photos of `roomIds`, by room, oldest first (the order they were taken in). */
export async function photosOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  roomIds: readonly string[],
): Promise<Map<string, ConditionPhotoView[]>> {
  const out = new Map<string, ConditionPhotoView[]>();
  if (roomIds.length === 0) return out;
  const { rows } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT}
      WHERE a.condition_room_id = ANY ($1::uuid[])
      ORDER BY a.condition_room_id, a.sort, a.created_at, a.id`,
    [roomIds],
  );
  const { rows: when } = await client.query<{ id: string; created_at: Date }>(
    'SELECT id, created_at FROM public.attachments WHERE condition_room_id = ANY ($1::uuid[])',
    [roomIds],
  );
  const added = new Map(when.map((w) => [w.id, w.created_at.toISOString()]));
  const views = await attachmentViews(client, files, rows);
  rows.forEach((r, i) => {
    const room = r.condition_room_id as string;
    const view = views[i] as AttachmentView;
    const list = out.get(room) ?? [];
    list.push({ ...view, addedAt: added.get(r.id) ?? '' });
    out.set(room, list);
  });
  return out;
}

const roomView = (r: RoomRecord, photos: ConditionPhotoView[]): ConditionRoomView => ({
  id: r.id,
  reportId: r.report_id,
  placeId: r.place_id,
  name: r.name,
  condition: r.condition,
  note: r.note,
  sort: r.sort,
  photos,
  rowVersion: r.row_version,
});

export async function roomsOf(client: pg.ClientBase, reportId: string): Promise<RoomRecord[]> {
  const { rows } = await client.query<RoomRecord>(
    `SELECT ${ROOM_COLUMNS} FROM public.condition_report_rooms rm
      WHERE rm.report_id = $1 ORDER BY rm.sort, rm.created_at, rm.id`,
    [reportId],
  );
  return rows;
}

export async function reportView(
  client: pg.ClientBase,
  files: FileStorage | null,
  id: string,
): Promise<ConditionReportView> {
  const r = await findReport(client, id);
  if (!r) throw notFound();
  const rooms = await roomsOf(client, r.id);
  const photos = await photosOf(
    client,
    files,
    rooms.map((x) => x.id),
  );
  const { rows: loc } = await client.query<{ timezone: string }>(
    'SELECT timezone FROM public.locations WHERE id = $1',
    [r.location_id],
  );
  const { rows: others } = await client.query<{
    id: string;
    kind: ConditionReportKind;
    held_on: string;
    finished_at: Date | null;
  }>(
    `SELECT id, kind, held_on::text AS held_on, finished_at FROM public.condition_reports
      WHERE location_id = $1 AND kind <> $2 ORDER BY held_on DESC, id DESC LIMIT 50`,
    [r.location_id, r.kind],
  );
  return {
    ...rowView(r),
    timezone: loc[0]?.timezone ?? 'UTC',
    rooms: rooms.map((x) => roomView(x, photos.get(x.id) ?? [])),
    others: others.map((o) => ({
      id: o.id,
      kind: o.kind,
      heldOn: o.held_on,
      finishedAt: o.finished_at?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/condition-reports
// ---------------------------------------------------------------------------------------------

const Cursor = z.tuple([Day, z.uuid()]);

/** The reports the caller can see, newest walk-through first. */
export async function listReports(
  client: pg.ClientBase,
  q: ReportsQuery,
  after: unknown,
): Promise<{ items: ConditionReportRowView[]; next_cursor: string | null }> {
  let cursor: [string, string] | null = null;
  if (after !== null && after !== undefined) {
    const parsed = Cursor.safeParse(after);
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    cursor = parsed.data;
  }
  const { rows } = await client.query<ReportRecord>(
    `SELECT ${REPORT_COLUMNS} FROM public.condition_reports r
       JOIN public.locations l ON l.id = r.location_id AND l.deleted_at IS NULL
      WHERE ($1::uuid IS NULL OR r.location_id = $1)
        AND ($2::text IS NULL OR r.kind = $2)
        AND ($3::text IS NULL OR (r.finished_at IS NOT NULL) = ($3 = 'finished'))
        AND ($4::date IS NULL OR (r.held_on, r.id) < ($4::date, $5::uuid))
      ORDER BY r.held_on DESC, r.id DESC
      LIMIT $6`,
    [
      q.locationId?.toLowerCase() ?? null,
      q.kind ?? null,
      q.state ?? null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      q.limit + 1,
    ],
  );
  const page = pageOf(rows, q.limit, (r) => [r.held_on, r.id]);
  return { items: page.items.map(rowView), next_cursor: page.next_cursor };
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export type WriteCtx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  files: FileStorage | null;
  requestId: string;
};

/** 404 unless the caller sees the location, 403 unless they may record its condition. */
async function requireWriter(client: pg.ClientBase, locationId: string) {
  const me = await requireMembership(client, locationId);
  requireCan(me.role, 'things.edit', 'Viewers can read condition reports but not change them.');
  return me;
}

export const finishedError = () =>
  new AppError(
    'conflict',
    409,
    'This report is finished, so it can’t change. Start a new one, or ask an owner or admin to delete it.',
    { reason: 'report_finished' },
  );

const reportImage = (r: {
  kind: string;
  held_on: string;
  notes: string | null;
  finished_at?: Date | null;
}) => ({
  kind: r.kind,
  held_on: r.held_on,
  notes: r.notes,
  ...(r.finished_at ? { finished_at: r.finished_at.toISOString() } : {}),
});

const roomImage = (
  r: Pick<RoomRecord, 'report_id' | 'place_id' | 'name' | 'condition' | 'note'>,
) => ({
  report_id: r.report_id,
  place_id: r.place_id,
  name: r.name,
  condition: r.condition,
  note: r.note,
});

/** The location's rooms a new report starts with: its places of the `room` kind (not the trash,
 * not Unplaced), in the tree's order; when it has none, its top-level places. */
async function startingRooms(
  client: pg.ClientBase,
  locationId: string,
): Promise<{ id: string; name: string }[]> {
  const { rows } = await client.query<{ id: string; name: string; is_room: boolean }>(
    `WITH RECURSIVE tree AS (
       SELECT p.id, p.name, p.kind_key, ARRAY[p.sort::bigint] AS sorts, ARRAY[p.name] AS names,
              0 AS depth
         FROM public.places p
        WHERE p.location_id = $1 AND p.parent_id IS NULL AND p.deleted_at IS NULL
          AND NOT p.is_unplaced
       UNION ALL
       SELECT c.id, c.name, c.kind_key, t.sorts || c.sort::bigint, t.names || c.name, t.depth + 1
         FROM public.places c JOIN tree t ON c.parent_id = t.id
        WHERE c.location_id = $1 AND c.deleted_at IS NULL AND t.depth < 20
     )
     SELECT id, name, kind_key = 'room' AS is_room FROM tree
      WHERE kind_key = 'room' OR depth = 0
      ORDER BY sorts, names, id`,
    [locationId],
  );
  const rooms = rows.filter((r) => r.is_room);
  return (rooms.length > 0 ? rooms : rows).slice(0, MAX_CONDITION_ROOMS);
}

export async function createReport(
  ctx: WriteCtx,
  locationId: string,
  body: CreateReportBody,
): Promise<ConditionReportView> {
  const loc = locationId.toLowerCase();
  await requireWriter(ctx.client, loc);
  const id = body.id ? assertClientId(body.id.toLowerCase()) : null;
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO public.condition_reports (id, location_id, kind, held_on, notes, created_by)
     VALUES (coalesce($1::uuid, uuidv7()), $2, $3, $4::date, $5, kept.current_user_id())
     RETURNING id`,
    [id, loc, body.kind, body.heldOn, body.notes?.trim() || null],
  );
  const reportId = (rows[0] as { id: string }).id;
  const rooms = await startingRooms(ctx.client, loc);
  if (rooms.length > 0) {
    await ctx.client.query(
      `INSERT INTO public.condition_report_rooms
         (location_id, report_id, place_id, name, sort, created_by)
       SELECT $1, $2, p.id, left(btrim(p.name), ${MAX_ROOM_NAME}), p.ord::int,
              kept.current_user_id()
         FROM unnest($3::uuid[], $4::text[]) WITH ORDINALITY AS p(id, name, ord)
        WHERE btrim(p.name) <> ''`,
      [loc, reportId, rooms.map((r) => r.id), rooms.map((r) => r.name)],
    );
  }
  await audited(ctx.tx, {
    locationId: loc,
    actor: actorOf(ctx.scope),
    action: 'condition_report.create',
    entity: { type: 'condition_report', id: reportId },
    before: null,
    after: {
      ...reportImage({ kind: body.kind, held_on: body.heldOn, notes: body.notes?.trim() || null }),
      rooms: rooms.map((r) => r.name),
    },
    requestId: ctx.requestId,
  });
  return reportView(ctx.client, ctx.files, reportId);
}

/** The report for a write: 404 invisible, 403 a viewer, 409 finished, 412 stale. */
async function writableReport(
  ctx: WriteCtx,
  id: string,
  expected: number | null,
  fields: readonly string[],
): Promise<ReportRecord> {
  // Read first, then lock: a FOR UPDATE passes the update policy, which a viewer and a finished
  // report fail, and they get their 403 and 409 rather than a 404.
  const seen = await findReport(ctx.client, id);
  if (!seen) throw notFound();
  await requireWriter(ctx.client, seen.location_id);
  if (seen.finished_at) throw finishedError();
  const r = await findReport(ctx.client, id, true);
  if (!r) throw finishedError();
  if (expected !== null && r.row_version !== expected) {
    const by = await lastChangedBy(ctx.client, r.location_id, {
      type: 'condition_report',
      id: r.id,
    });
    checkVersion({ rowVersion: r.row_version }, expected, fields, by ? { displayName: by } : null);
  }
  return r;
}

export async function updateReport(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: UpdateReportBody,
): Promise<ConditionReportView> {
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdateReportBody] !== undefined);
  const before = await writableReport(ctx, id, expected, fields);
  const notes = body.notes === undefined ? before.notes : body.notes?.trim() || null;
  await ctx.client.query(
    `UPDATE public.condition_reports
        SET kind = coalesce($2, kind), held_on = coalesce($3::date, held_on), notes = $4
      WHERE id = $1`,
    [before.id, body.kind ?? null, body.heldOn ?? null, notes],
  );
  const after = (await findReport(ctx.client, before.id)) as ReportRecord;
  await audited(ctx.tx, {
    locationId: before.location_id,
    actor: actorOf(ctx.scope),
    action: 'condition_report.update',
    entity: { type: 'condition_report', id: before.id },
    before: reportImage(before),
    after: reportImage(after),
    requestId: ctx.requestId,
  });
  return reportView(ctx.client, ctx.files, before.id);
}

export async function finishReport(
  ctx: WriteCtx,
  id: string,
  expected: number,
): Promise<ConditionReportView> {
  const before = await writableReport(ctx, id, expected, ['finishedAt']);
  await ctx.client.query(
    `UPDATE public.condition_reports SET finished_at = now(), finished_by = kept.current_user_id()
      WHERE id = $1`,
    [before.id],
  );
  const after = (await findReport(ctx.client, before.id)) as ReportRecord;
  await audited(ctx.tx, {
    locationId: before.location_id,
    actor: actorOf(ctx.scope),
    action: 'condition_report.finish',
    entity: { type: 'condition_report', id: before.id },
    before: { finished_at: null },
    after: { finished_at: after.finished_at?.toISOString() ?? null },
    requestId: ctx.requestId,
  });
  return reportView(ctx.client, ctx.files, before.id);
}

export async function deleteReport(ctx: WriteCtx, id: string, expected: number): Promise<void> {
  // Not locked: a finished report can't be (the update policy), and the DELETE is one statement.
  const r = await findReport(ctx.client, id);
  if (!r) throw notFound();
  const me = await requireWriter(ctx.client, r.location_id);
  if (r.finished_at && me.role !== 'owner' && me.role !== 'admin') {
    throw forbidden('Only owners and admins can delete a finished report.');
  }
  if (r.row_version !== expected) {
    const by = await lastChangedBy(ctx.client, r.location_id, {
      type: 'condition_report',
      id: r.id,
    });
    checkVersion({ rowVersion: r.row_version }, expected, [], by ? { displayName: by } : null);
  }
  const rooms = await roomsOf(ctx.client, r.id);
  const { rowCount } = await ctx.client.query(
    'DELETE FROM public.condition_reports WHERE id = $1',
    [r.id],
  );
  if (!rowCount) throw notFound();
  await audited(ctx.tx, {
    locationId: r.location_id,
    actor: actorOf(ctx.scope),
    action: 'condition_report.delete',
    entity: { type: 'condition_report', id: r.id },
    before: {
      ...reportImage(r),
      rooms: rooms.map((x) => x.name),
      photos: r.photo_count,
    },
    after: null,
    requestId: ctx.requestId,
  });
}

// ----- rooms ---------------------------------------------------------------------------------

async function findRoom(client: pg.ClientBase, id: string, lock = false) {
  const { rows } = await client.query<RoomRecord & { finished: boolean }>(
    `SELECT ${ROOM_COLUMNS}, r.finished_at IS NOT NULL AS finished
       FROM public.condition_report_rooms rm
       JOIN public.condition_reports r ON r.id = rm.report_id
      WHERE rm.id = $1${lock ? ' FOR UPDATE OF rm' : ''}`,
    [id.toLowerCase()],
  );
  return rows[0] ?? null;
}

async function oneRoomView(
  client: pg.ClientBase,
  files: FileStorage | null,
  id: string,
): Promise<ConditionRoomView> {
  const r = await findRoom(client, id);
  if (!r) throw notFound();
  const photos = await photosOf(client, files, [r.id]);
  return roomView(r, photos.get(r.id) ?? []);
}

export async function createRoom(
  ctx: WriteCtx,
  reportId: string,
  body: CreateRoomBody,
): Promise<ConditionRoomView> {
  const report = await writableReport(ctx, reportId, null, []);
  if (report.room_count >= MAX_CONDITION_ROOMS) {
    throw new AppError(
      'conflict',
      409,
      `A report holds at most ${MAX_CONDITION_ROOMS} rooms; start another for the rest.`,
      { reason: 'too_many_rooms' },
    );
  }
  let placeId: string | null = null;
  let name = body.name?.trim() ?? '';
  if (body.placeId) {
    const { rows } = await ctx.client.query<{ name: string }>(
      `SELECT name FROM public.places
        WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL AND NOT is_unplaced`,
      [body.placeId.toLowerCase(), report.location_id],
    );
    const place = rows[0];
    if (!place) throw invalid('Check body.placeId: pick a place in the report’s location.');
    placeId = body.placeId.toLowerCase();
    if (!name) name = place.name.trim().slice(0, MAX_ROOM_NAME);
  }
  const id = body.id ? assertClientId(body.id.toLowerCase()) : null;
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO public.condition_report_rooms
       (id, location_id, report_id, place_id, name, sort, created_by)
     VALUES (coalesce($1::uuid, uuidv7()), $2, $3, $4, $5,
             (SELECT coalesce(max(sort), 0) + 1 FROM public.condition_report_rooms
               WHERE report_id = $3),
             kept.current_user_id())
     RETURNING id`,
    [id, report.location_id, report.id, placeId, name],
  );
  const roomId = (rows[0] as { id: string }).id;
  await audited(ctx.tx, {
    locationId: report.location_id,
    actor: actorOf(ctx.scope),
    action: 'condition_room.create',
    entity: { type: 'condition_room', id: roomId },
    before: null,
    after: roomImage({
      report_id: report.id,
      place_id: placeId,
      name,
      condition: null,
      note: null,
    }),
    requestId: ctx.requestId,
  });
  return oneRoomView(ctx.client, ctx.files, roomId);
}

/** The room for a write: 404 invisible, 403 a viewer, 409 its report finished, 412 stale. */
async function writableRoom(
  ctx: WriteCtx,
  id: string,
  expected: number,
  fields: readonly string[],
) {
  // Read first, then lock (as writableReport does).
  const seen = await findRoom(ctx.client, id);
  if (!seen) throw notFound();
  await requireWriter(ctx.client, seen.location_id);
  if (seen.finished) throw finishedError();
  const r = await findRoom(ctx.client, id, true);
  if (!r) throw finishedError();
  if (r.row_version !== expected) {
    const by = await lastChangedBy(ctx.client, r.location_id, { type: 'condition_room', id: r.id });
    checkVersion({ rowVersion: r.row_version }, expected, fields, by ? { displayName: by } : null);
  }
  return r;
}

export async function updateRoom(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: UpdateRoomBody,
): Promise<ConditionRoomView> {
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdateRoomBody] !== undefined);
  const before = await writableRoom(ctx, id, expected, fields);
  const condition = body.condition === undefined ? before.condition : body.condition;
  const note = body.note === undefined ? before.note : body.note?.trim() || null;
  await ctx.client.query(
    `UPDATE public.condition_report_rooms
        SET name = coalesce($2, name), condition = $3, note = $4, sort = coalesce($5, sort)
      WHERE id = $1`,
    [before.id, body.name?.trim() ?? null, condition, note, body.sort ?? null],
  );
  const after = (await findRoom(ctx.client, before.id)) as RoomRecord;
  await audited(ctx.tx, {
    locationId: before.location_id,
    actor: actorOf(ctx.scope),
    action: 'condition_room.update',
    entity: { type: 'condition_room', id: before.id },
    before: { ...roomImage(before), sort: before.sort },
    after: { ...roomImage(after), sort: after.sort },
    requestId: ctx.requestId,
  });
  return oneRoomView(ctx.client, ctx.files, before.id);
}

export async function deleteRoom(ctx: WriteCtx, id: string, expected: number): Promise<void> {
  const r = await writableRoom(ctx, id, expected, []);
  const { rows: photos } = await ctx.client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.attachments WHERE condition_room_id = $1',
    [r.id],
  );
  const { rowCount } = await ctx.client.query(
    'DELETE FROM public.condition_report_rooms WHERE id = $1',
    [r.id],
  );
  if (!rowCount) throw notFound();
  await audited(ctx.tx, {
    locationId: r.location_id,
    actor: actorOf(ctx.scope),
    action: 'condition_room.delete',
    entity: { type: 'condition_room', id: r.id },
    before: { ...roomImage(r), photos: photos[0]?.n ?? 0 },
    after: null,
    requestId: ctx.requestId,
  });
}

// ----- photos (files/attachments.ts asks) ----------------------------------------------------

/**
 * Before a photo is attached to a room (POST /attachments, subject `conditionRoomId`): only a
 * photo, only while the report is open, at most MAX_ROOM_PHOTOS a room. The room's visibility
 * and the caller's role are the attachment route's own checks.
 */
export async function checkRoomPhoto(
  client: pg.ClientBase,
  roomId: string,
  role: string,
): Promise<void> {
  if (role !== 'photo') {
    throw invalid('Check body.role: a condition report’s room takes photos.');
  }
  const room = await findRoom(client, roomId);
  if (!room) throw notFound();
  if (room.finished) throw finishedError();
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.attachments WHERE condition_room_id = $1',
    [room.id],
  );
  if ((rows[0]?.n ?? 0) >= MAX_ROOM_PHOTOS) {
    throw new AppError(
      'conflict',
      409,
      `A room holds at most ${MAX_ROOM_PHOTOS} photos; remove one first.`,
      { reason: 'too_many_photos' },
    );
  }
}

/** Before a room's photo is changed or removed: 409 once its report is finished. */
export async function checkRoomOpen(client: pg.ClientBase, roomId: string): Promise<void> {
  const room = await findRoom(client, roomId);
  if (room?.finished) throw finishedError();
}
