import {
  BOX_STATES,
  type BoxCounts,
  type BoxState,
  boxName,
  countBoxes,
  MAX_BOX_PREFIX,
  MAX_MOVE_BOXES,
  MAX_MOVE_NAME,
  MOVE_STATUSES,
  type MoveStatus,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import {
  lastChangedBy,
  registerUndo,
  type UndoArgs,
  undoableUntil,
  undoConflict,
} from '../audit/undo.js';
import { assertClientId, checkVersion, pageOf } from '../http/conventions.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { moveBackForUndo, moveThings } from '../things/move.js';
import { type Ctx, insertThing, liveThing } from '../things/service.js';

// Moving mode (1.x, D39 (5), D251): pack a home into numbered boxes, carry them, unpack them at
// the other end. The web contract is apps/web/src/api/moving/types.ts.
//
// The model (D251): a **move** belongs to the location being packed and may name the location it
// is going to (null: the boxes stay in this location). Its **boxes** are ordinary containers
// (things), each with its number in the move, the room it goes to (a place in the destination)
// and its state: packed → in transit → unpacked. What is in a box is what is in the container;
// packing is the ordinary move of things into it (D45), and so is unpacking: the container moves
// into its room through things/move.ts, carrying its contents (their timelines say "moved with
// Box 3", D45), across locations through kept.move_things() when the move goes elsewhere.
//
// Who (D251): everyone who sees the move's location reads its moves and boxes, viewers included;
// starting, packing, marking and unpacking is `things.edit` (members and above). Unpacking into
// another location also needs the caller to write there (the move's own rule: 404 otherwise).
// Every route belongs to the Moving mode module of the move's location (http/modules.ts); the
// `move_box` sync op checks the same.
//
// Audit: `move.create|update|delete`; `move_box.create|update|unpack|delete` on the box's
// container (entity `thing`, so its timeline shows them), their diff a `box` image with the move
// id. A state change (`move_box.update` with a new state) and an unpack are undoable for 7 days
// (D150): the undo puts the state back, and an unpack's undo also moves the box back where it was
// (moveBackForUndo, with the forward move's checks). The container's own move is a plain
// `thing.move` without an undo window of its own: the unpack's event is the one to undo.
//
// GET    /api/v1/moves?locationId&status&cursor&limit           → {items: MoveRow[], next_cursor}
// GET    /api/v1/moves/:id                                       → Move (its boxes in number order)
// POST   /api/v1/locations/:id/moves                             → 201 Move
// PATCH  /api/v1/moves/:id (If-Match)                            → Move
// DELETE /api/v1/moves/:id (If-Match)                            → 204
// POST   /api/v1/moves/:id/boxes                                 → 201 MoveBox
// PATCH  /api/v1/moves/:id/boxes/:containerId                    → MoveBox
// POST   /api/v1/moves/:id/boxes/:containerId/unpack             → MoveBox
// DELETE /api/v1/moves/:id/boxes/:containerId                    → 204
// GET    /api/v1/move-boxes/:containerId                         → MoveBox & {move} (open moves first)

const Name = z.string().trim().min(1).max(MAX_MOVE_NAME);
const State = z.enum(BOX_STATES);

export const CreateMoveBody = z
  .object({
    id: z.uuid().optional(),
    name: Name,
    /** Where the boxes go; omitted: they stay in this location. */
    toLocationId: z.uuid().optional(),
  })
  .strict();
export type CreateMoveBody = z.infer<typeof CreateMoveBody>;

export const UpdateMoveBody = z
  .object({
    name: Name.optional(),
    toLocationId: z.uuid().nullable().optional(),
    status: z.enum(MOVE_STATUSES).optional(),
  })
  .strict();
export type UpdateMoveBody = z.infer<typeof UpdateMoveBody>;

export const MovesQuery = z.object({
  locationId: z.uuid().optional(),
  status: z.enum(MOVE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
});
export type MovesQuery = z.infer<typeof MovesQuery>;

export const AddBoxBody = z
  .object({
    /** A container that exists: it joins the move as the next number. */
    containerId: z.uuid().optional(),
    /** A new box, made in the move's location: "<prefix> <number>", a box (D43). */
    new: z
      .object({
        id: z.uuid().optional(),
        /** The word before its number, in the person's language ("Box", "صندوق"). */
        prefix: z.string().trim().min(1).max(MAX_BOX_PREFIX).optional(),
        /** Where it is packed; omitted: the location's Unplaced area. */
        placeId: z.uuid().optional(),
      })
      .strict()
      .optional(),
    destinationPlaceId: z.uuid().optional(),
  })
  .strict()
  .refine((b) => (b.containerId === undefined) !== (b.new === undefined), {
    message: 'a container or a new box',
    path: ['containerId'],
  });
export type AddBoxBody = z.infer<typeof AddBoxBody>;

export const UpdateBoxBody = z
  .object({
    state: State.optional(),
    destinationPlaceId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((b) => b.state !== undefined || b.destinationPlaceId !== undefined, {
    message: 'a state or a room',
    path: ['state'],
  });
export type UpdateBoxBody = z.infer<typeof UpdateBoxBody>;

export const UnpackBody = z
  .object({
    /** The room it goes into; omitted: the room chosen for it. */
    placeId: z.uuid().optional(),
  })
  .strict();
export type UnpackBody = z.infer<typeof UnpackBody>;

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

type Person = { displayName: string };

export type MoveRowView = {
  id: string;
  locationId: string;
  /** Where it is going; null within the same location. */
  toLocationId: string | null;
  /** Null when the caller can't see that location. */
  toLocationName: string | null;
  name: string;
  status: MoveStatus;
  createdBy: Person;
  createdAt: string;
  finishedAt: string | null;
  counts: BoxCounts;
  rowVersion: number;
};

export type MoveBoxView = {
  moveId: string;
  containerId: string;
  number: number;
  state: BoxState;
  stateAt: string;
  stateBy: Person | null;
  /** False when the box is somewhere the caller can't see (unpacked into another location). */
  visible: boolean;
  /** The container's name, short ID, location and where it is now; null when not visible. */
  name: string | null;
  shortCode: string | null;
  locationId: string | null;
  placeId: string | null;
  /** "Kitchen › Shelf", where the box is now. */
  where: string | null;
  /** Things directly inside it (a box inside counts once). */
  contents: number;
  destination: { placeId: string; name: string; locationId: string } | null;
  rowVersion: number;
};

export type MoveView = MoveRowView & { boxes: MoveBoxView[] };

type MoveRecord = {
  id: string;
  location_id: string;
  to_location_id: string | null;
  to_location_name: string | null;
  name: string;
  status: MoveStatus;
  created_by: string;
  created_name: string | null;
  created_at: Date;
  finished_at: Date | null;
  row_version: number;
  packed: number;
  in_transit: number;
  unpacked: number;
};

const MOVE_COLUMNS = `m.id, m.location_id, m.to_location_id,
  (SELECT l.name FROM public.locations l WHERE l.id = m.to_location_id AND l.deleted_at IS NULL)
    AS to_location_name,
  m.name, m.status, m.created_by, m.created_at, m.finished_at, m.row_version,
  (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = m.created_by)
    AS created_name,
  (SELECT count(*) FROM public.move_boxes b WHERE b.move_id = m.id AND b.state = 'packed')::int
    AS packed,
  (SELECT count(*) FROM public.move_boxes b WHERE b.move_id = m.id AND b.state = 'in_transit')::int
    AS in_transit,
  (SELECT count(*) FROM public.move_boxes b WHERE b.move_id = m.id AND b.state = 'unpacked')::int
    AS unpacked`;

const rowView = (r: MoveRecord): MoveRowView => ({
  id: r.id,
  locationId: r.location_id,
  toLocationId: r.to_location_id,
  toLocationName: r.to_location_name,
  name: r.name,
  status: r.status,
  createdBy: { displayName: r.created_name ?? '' },
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  counts: {
    packed: r.packed,
    in_transit: r.in_transit,
    unpacked: r.unpacked,
    total: r.packed + r.in_transit + r.unpacked,
  },
  rowVersion: r.row_version,
});

/** The move as the caller sees it; null when invisible. */
export async function findMove(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<MoveRecord | null> {
  const { rows } = await client.query<MoveRecord>(
    `SELECT ${MOVE_COLUMNS} FROM public.moves m WHERE m.id = $1${lock ? ' FOR UPDATE OF m' : ''}`,
    [id.toLowerCase()],
  );
  return rows[0] ?? null;
}

type BoxRecord = {
  move_id: string;
  location_id: string;
  container_id: string;
  number: number;
  state: BoxState;
  state_at: Date;
  state_by_name: string | null;
  state_by: string | null;
  destination_place_id: string | null;
  destination_name: string | null;
  destination_location_id: string | null;
  row_version: number;
  /** The container as the caller sees it (null when they can't). */
  t_id: string | null;
  t_name: string | null;
  t_location_id: string | null;
  t_place_id: string | null;
  t_container_id: string | null;
  t_path: string | null;
  t_deleted: boolean | null;
  short_code: string | null;
  contents: number;
};

const BOX_COLUMNS = `b.move_id, b.location_id, b.container_id, b.number, b.state, b.state_at,
    b.state_by, b.destination_place_id, b.row_version,
    (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = b.state_by)
      AS state_by_name,
    d.name AS destination_name, d.location_id AS destination_location_id,
    t.id AS t_id, t.name AS t_name, t.location_id AS t_location_id, t.place_id AS t_place_id,
    t.container_id AS t_container_id, t.place_path AS t_path, t.deleted_at IS NOT NULL AS t_deleted,
    (SELECT s.code FROM public.short_ids s
      WHERE s.thing_id = b.container_id AND s.is_primary AND s.state = 'assigned' LIMIT 1)
      AS short_code,
    (SELECT count(*) FROM public.things c
      WHERE c.container_id = b.container_id AND c.deleted_at IS NULL)::int AS contents`;
const BOX_JOINS = `LEFT JOIN public.things t ON t.id = b.container_id
  LEFT JOIN public.places d ON d.id = b.destination_place_id AND d.deleted_at IS NULL`;
const BOX_SELECT = `SELECT ${BOX_COLUMNS} FROM public.move_boxes b ${BOX_JOINS}`;

const boxView = (r: BoxRecord): MoveBoxView => {
  const visible = r.t_id !== null && r.t_deleted === false;
  return {
    moveId: r.move_id,
    containerId: r.container_id,
    number: r.number,
    state: r.state,
    stateAt: r.state_at.toISOString(),
    stateBy: r.state_by ? { displayName: r.state_by_name ?? '' } : null,
    visible,
    name: visible ? r.t_name : null,
    shortCode: visible ? r.short_code : null,
    locationId: visible ? r.t_location_id : null,
    placeId: visible ? r.t_place_id : null,
    where: visible ? r.t_path : null,
    contents: visible ? r.contents : 0,
    destination:
      r.destination_place_id && r.destination_name !== null && r.destination_location_id
        ? {
            placeId: r.destination_place_id,
            name: r.destination_name,
            locationId: r.destination_location_id,
          }
        : null,
    rowVersion: r.row_version,
  };
};

async function findBox(
  client: pg.ClientBase,
  moveId: string,
  containerId: string,
  lock = false,
): Promise<BoxRecord | null> {
  const { rows } = await client.query<BoxRecord>(
    `${BOX_SELECT} WHERE b.move_id = $1 AND b.container_id = $2${lock ? ' FOR UPDATE OF b' : ''}`,
    [moveId.toLowerCase(), containerId.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function boxesOf(client: pg.ClientBase, moveId: string): Promise<MoveBoxView[]> {
  const { rows } = await client.query<BoxRecord>(
    `${BOX_SELECT} WHERE b.move_id = $1 ORDER BY b.number`,
    [moveId],
  );
  return rows.map(boxView);
}

export async function moveView(client: pg.ClientBase, id: string): Promise<MoveView> {
  const m = await findMove(client, id);
  if (!m) throw notFound();
  return { ...rowView(m), boxes: await boxesOf(client, m.id) };
}

/** GET /api/v1/move-boxes/:containerId: the box a container is in a move as (an open move
 * first, then the latest), for a scanned label. 404 when it is in none the caller sees. */
export async function boxOfContainer(
  client: pg.ClientBase,
  containerId: string,
): Promise<MoveBoxView & { move: { id: string; name: string; status: MoveStatus } }> {
  const { rows } = await client.query<BoxRecord & { m_name: string; m_status: MoveStatus }>(
    `SELECT m.name AS m_name, m.status AS m_status, ${BOX_COLUMNS}
       FROM public.move_boxes b JOIN public.moves m ON m.id = b.move_id ${BOX_JOINS}
      WHERE b.container_id = $1
      ORDER BY m.status = 'active' DESC, m.created_at DESC
      LIMIT 1`,
    [containerId.toLowerCase()],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return { ...boxView(r), move: { id: r.move_id, name: r.m_name, status: r.m_status } };
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/moves
// ---------------------------------------------------------------------------------------------

const Cursor = z.tuple([z.string(), z.uuid()]);

/** The moves the caller can see, open ones first, newest first. */
export async function listMoves(
  client: pg.ClientBase,
  q: MovesQuery,
  after: unknown,
): Promise<{ items: MoveRowView[]; next_cursor: string | null }> {
  let cursor: [string, string] | null = null;
  if (after !== null && after !== undefined) {
    const parsed = Cursor.safeParse(after);
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    cursor = parsed.data;
  }
  // The sort key: open before done, then newest first, as one string that sorts descending.
  const { rows } = await client.query<MoveRecord & { k: string }>(
    `SELECT * FROM (
       SELECT ${MOVE_COLUMNS},
              (CASE WHEN m.status = 'active' THEN '1' ELSE '0' END)
                || to_char(m.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS k
         FROM public.moves m
         JOIN public.locations l ON l.id = m.location_id AND l.deleted_at IS NULL
        WHERE ($1::uuid IS NULL OR m.location_id = $1)
          AND ($2::text IS NULL OR m.status = $2)
     ) x
     WHERE ($3::text IS NULL OR (x.k, x.id) < ($3::text, $4::uuid))
     ORDER BY x.k DESC, x.id DESC
     LIMIT $5`,
    [
      q.locationId?.toLowerCase() ?? null,
      q.status ?? null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      q.limit + 1,
    ],
  );
  const page = pageOf(rows, q.limit, (r) => [r.k, r.id]);
  return { items: page.items.map(rowView), next_cursor: page.next_cursor };
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export type WriteCtx = Ctx;

const VIEWERS_READ = 'Viewers can follow a move but not change it.';

/** 404 unless the caller sees the location, 403 unless they may pack there. */
async function requireWriter(client: pg.ClientBase, locationId: string) {
  const me = await requireMembership(client, locationId);
  requireCan(me.role, 'things.edit', VIEWERS_READ);
  return me;
}

export const moveDoneError = () =>
  new AppError('conflict', 409, 'This move is marked done. Open it again to change its boxes.', {
    reason: 'move_done',
  });

/** 409 `module_off` unless Moving mode is on in the location (for the sync op; the routes are
 * gated by http/modules.ts). */
export async function requireMovingOn(ctx: Pick<Ctx, 'tx'>, locationId: string): Promise<void> {
  if (!(await locationModuleSet(ctx.tx, locationId))?.has('moving')) {
    throw new AppError('module_off', 409);
  }
}

/** A destination a move may point at: a location the caller writes, not the move's own. */
async function checkDestination(
  client: pg.ClientBase,
  locationId: string,
  toLocationId: string | null,
): Promise<string | null> {
  if (toLocationId === null) return null;
  const to = toLocationId.toLowerCase();
  if (to === locationId) return null;
  const me = await requireMembership(client, to);
  requireCan(me.role, 'things.edit', 'Choose a location where you can add things.');
  return to;
}

const moveImage = (m: {
  name: string;
  to_location_id: string | null;
  status: string;
  finished_at?: Date | null;
}) => ({
  name: m.name,
  to_location_id: m.to_location_id,
  status: m.status,
});

export async function createMove(
  ctx: WriteCtx,
  locationId: string,
  body: CreateMoveBody,
): Promise<MoveView> {
  const loc = locationId.toLowerCase();
  await requireWriter(ctx.client, loc);
  const to = await checkDestination(ctx.client, loc, body.toLocationId ?? null);
  const id = body.id ? assertClientId(body.id.toLowerCase()) : null;
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO public.moves (id, location_id, to_location_id, name, created_by)
     VALUES (coalesce($1::uuid, uuidv7()), $2, $3, $4, kept.current_user_id())
     RETURNING id`,
    [id, loc, to, body.name.trim()],
  );
  const moveId = (rows[0] as { id: string }).id;
  await audited(ctx.tx, {
    locationId: loc,
    actor: actorOf(ctx.scope),
    action: 'move.create',
    entity: { type: 'move', id: moveId },
    before: null,
    after: moveImage({ name: body.name.trim(), to_location_id: to, status: 'active' }),
    requestId: ctx.requestId,
  });
  return moveView(ctx.client, moveId);
}

/** The move for a write: 404 invisible, 403 a viewer, 412 stale. Locked. */
async function writableMove(
  ctx: WriteCtx,
  id: string,
  expected: number | null,
  fields: readonly string[] = [],
): Promise<MoveRecord> {
  // Read first, then lock: a FOR UPDATE passes the update policy, which a viewer fails, and they
  // get their 403 rather than a 404.
  const seen = await findMove(ctx.client, id);
  if (!seen) throw notFound();
  await requireWriter(ctx.client, seen.location_id);
  const m = (await findMove(ctx.client, id, true)) as MoveRecord;
  if (expected !== null && m.row_version !== expected) {
    const by = await lastChangedBy(ctx.client, m.location_id, { type: 'move', id: m.id });
    checkVersion({ rowVersion: m.row_version }, expected, fields, by ? { displayName: by } : null);
  }
  return m;
}

export async function updateMove(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: UpdateMoveBody,
): Promise<MoveView> {
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdateMoveBody] !== undefined);
  const before = await writableMove(ctx, id, expected, fields);
  const to =
    body.toLocationId === undefined
      ? before.to_location_id
      : await checkDestination(ctx.client, before.location_id, body.toLocationId);
  const status = body.status ?? before.status;
  await ctx.client.query(
    `UPDATE public.moves
        SET name = $2, to_location_id = $3, status = $4,
            finished_at = CASE WHEN $4 = 'done' THEN coalesce(finished_at, now()) END
      WHERE id = $1`,
    [before.id, body.name?.trim() ?? before.name, to, status],
  );
  const after = (await findMove(ctx.client, before.id)) as MoveRecord;
  await audited(ctx.tx, {
    locationId: before.location_id,
    actor: actorOf(ctx.scope),
    action: 'move.update',
    entity: { type: 'move', id: before.id },
    before: moveImage(before),
    after: moveImage(after),
    requestId: ctx.requestId,
  });
  return moveView(ctx.client, before.id);
}

export async function deleteMove(ctx: WriteCtx, id: string, expected: number): Promise<void> {
  const m = await writableMove(ctx, id, expected);
  const boxes = await boxesOf(ctx.client, m.id);
  await ctx.client.query('DELETE FROM public.moves WHERE id = $1', [m.id]);
  await audited(ctx.tx, {
    locationId: m.location_id,
    actor: actorOf(ctx.scope),
    action: 'move.delete',
    entity: { type: 'move', id: m.id },
    before: { ...moveImage(m), boxes: boxes.length },
    after: null,
    requestId: ctx.requestId,
  });
}

// ----- Boxes -------------------------------------------------------------------------------------

type BoxImage = {
  move_id: string;
  number: number;
  state: BoxState;
  destination_place_id: string | null;
  state_at: string;
};

const boxImage = (
  b: Pick<
    BoxRecord,
    'move_id' | 'number' | 'state' | 'destination_place_id' | 'state_at' | 'container_id'
  >,
): BoxImage => ({
  move_id: b.move_id,
  number: b.number,
  state: b.state,
  destination_place_id: b.destination_place_id,
  state_at: b.state_at.toISOString(),
});

/** A room the box may go to: a live place the caller sees, in the move's destination (its own
 * location when it goes nowhere else). 404 otherwise. */
async function checkRoom(
  client: pg.ClientBase,
  move: Pick<MoveRecord, 'location_id' | 'to_location_id'>,
  placeId: string,
): Promise<string> {
  const id = placeId.toLowerCase();
  const { rows } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.places WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  const where = rows[0]?.location_id;
  if (!where) throw notFound();
  const dest = move.to_location_id ?? move.location_id;
  if (where !== dest) {
    throw invalid('Choose a room where the move is going.');
  }
  return id;
}

export async function addBox(ctx: WriteCtx, moveId: string, body: AddBoxBody) {
  const m = await writableMove(ctx, moveId, null);
  if (m.status !== 'active') throw moveDoneError();
  const destination = body.destinationPlaceId
    ? await checkRoom(ctx.client, m, body.destinationPlaceId)
    : null;
  const { rows: last } = await ctx.client.query<{ n: number | null; c: number }>(
    'SELECT max(number) AS n, count(*)::int AS c FROM public.move_boxes WHERE move_id = $1',
    [m.id],
  );
  if ((last[0]?.c ?? 0) >= MAX_MOVE_BOXES) {
    throw new AppError('conflict', 409, `A move holds at most ${MAX_MOVE_BOXES} boxes.`, {
      reason: 'too_many_boxes',
    });
  }
  const number = (last[0]?.n ?? 0) + 1;
  if (number > MAX_MOVE_BOXES) {
    throw new AppError('conflict', 409, `A move holds at most ${MAX_MOVE_BOXES} boxes.`, {
      reason: 'too_many_boxes',
    });
  }

  let containerId: string;
  if (body.new) {
    // D43's "New box": a box in the move's location, where it is packed.
    let placeId = body.new.placeId?.toLowerCase();
    if (!placeId) {
      const { rows } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
        [m.location_id],
      );
      placeId = rows[0]?.id;
      if (!placeId) throw notFound();
    }
    const { rows: type } = await ctx.client.query<{ id: string }>(
      `SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'box_bin'`,
    );
    containerId = await insertThing(ctx, {
      ...(body.new.id ? { id: body.new.id } : {}),
      locationId: m.location_id,
      placeId,
      name: boxName(body.new.prefix ?? 'Box', number),
      ...(type[0] ? { typeId: type[0].id } : {}),
    });
  } else {
    const thing = await liveThing(ctx.client, (body.containerId as string).toLowerCase());
    if (thing.location_id !== m.location_id) {
      throw invalid('Add a box that is in the location being packed.');
    }
    containerId = thing.id;
    const { rows: other } = await ctx.client.query<{ number: number; name: string }>(
      `SELECT b.number, m.name FROM public.move_boxes b JOIN public.moves m ON m.id = b.move_id
        WHERE b.container_id = $1 AND m.status = 'active'`,
      [containerId],
    );
    if (other[0]) {
      throw new AppError(
        'conflict',
        409,
        `It is already box ${other[0].number} of “${other[0].name}”.`,
        { reason: 'already_in_a_move' },
      );
    }
  }

  await ctx.client.query(
    `INSERT INTO public.move_boxes (location_id, move_id, container_id, number,
                                    destination_place_id, created_by, state_by)
     VALUES ($1, $2, $3, $4, $5, kept.current_user_id(), kept.current_user_id())`,
    [m.location_id, m.id, containerId, number, destination],
  );
  const made = (await findBox(ctx.client, m.id, containerId)) as BoxRecord;
  await audited(ctx.tx, {
    locationId: m.location_id,
    actor: actorOf(ctx.scope),
    action: 'move_box.create',
    entity: { type: 'thing', id: containerId },
    before: null,
    after: { box: boxImage(made) },
    rootThingId: containerId,
    subjects: [containerId],
    requestId: ctx.requestId,
  });
  return boxView(made);
}

/** The box for a write: 404 invisible (the move or the box), 403 a viewer, 409 a done move. */
async function writableBox(
  ctx: WriteCtx,
  moveId: string,
  containerId: string,
): Promise<{ move: MoveRecord; box: BoxRecord }> {
  const move = await writableMove(ctx, moveId, null);
  const box = await findBox(ctx.client, move.id, containerId, true);
  if (!box) throw notFound();
  if (move.status !== 'active') throw moveDoneError();
  return { move, box };
}

export type BoxWriteOptions = {
  /** When it happened: now online, the op's `takenAt` from the phone (D112). */
  at?: Date;
};

/** Whether a change dated `at` is older than the box's last state change: it changes nothing. */
const superseded = (box: BoxRecord, at: Date | undefined) =>
  at !== undefined && at.getTime() < box.state_at.getTime();

export type BoxWrite = { box: MoveBoxView; changed: boolean };

/**
 * PATCH /api/v1/moves/:id/boxes/:containerId, and the `move_box` op without a room: a new state
 * (undoable) and/or the room it goes to. A state change dated before the box's last one (an
 * offline op arriving late) changes nothing.
 */
export async function updateBox(
  ctx: WriteCtx,
  moveId: string,
  containerId: string,
  body: UpdateBoxBody,
  opts: BoxWriteOptions = {},
): Promise<BoxWrite> {
  const { move, box } = await writableBox(ctx, moveId, containerId);
  const stateChange = body.state !== undefined && body.state !== box.state;
  if (stateChange && superseded(box, opts.at)) return { box: boxView(box), changed: false };
  const destination =
    body.destinationPlaceId === undefined
      ? box.destination_place_id
      : body.destinationPlaceId === null
        ? null
        : await checkRoom(ctx.client, move, body.destinationPlaceId);
  if (!stateChange && destination === box.destination_place_id) {
    return { box: boxView(box), changed: false };
  }
  await ctx.client.query(
    `UPDATE public.move_boxes
        SET state = $3, destination_place_id = $4,
            state_at = CASE WHEN $5::boolean THEN coalesce($6::timestamptz, now()) ELSE state_at END,
            state_by = CASE WHEN $5::boolean THEN kept.current_user_id() ELSE state_by END
      WHERE move_id = $1 AND container_id = $2`,
    [
      box.move_id,
      box.container_id,
      body.state ?? box.state,
      destination,
      stateChange,
      opts.at?.toISOString() ?? null,
    ],
  );
  const after = (await findBox(ctx.client, box.move_id, box.container_id)) as BoxRecord;
  await audited(ctx.tx, {
    locationId: move.location_id,
    actor: actorOf(ctx.scope),
    action: 'move_box.update',
    entity: { type: 'thing', id: box.container_id },
    before: { box: boxImage(box) },
    after: { box: boxImage(after) },
    rootThingId: box.container_id,
    subjects: [box.container_id],
    requestId: ctx.requestId,
    // A state change can be taken back; a room alone is simply chosen again.
    undoableUntil: stateChange ? undoableUntil() : null,
  });
  return { box: boxView(after), changed: true };
}

type Whereabouts = { location_id: string; place_id: string | null; container_id: string | null };

/**
 * POST /api/v1/moves/:id/boxes/:containerId/unpack, and the `move_box` op with `unpacked`: the
 * box goes into its room (the body's, else the one chosen for it) with everything inside it, and
 * is unpacked. Undoable: the undo puts the box back where it was and its state as it was.
 */
export async function unpackBox(
  ctx: WriteCtx,
  moveId: string,
  containerId: string,
  body: UnpackBody,
  opts: BoxWriteOptions = {},
): Promise<BoxWrite> {
  const { move, box } = await writableBox(ctx, moveId, containerId);
  if (box.state !== 'unpacked' && superseded(box, opts.at)) {
    return { box: boxView(box), changed: false };
  }
  const room = body.placeId
    ? await checkRoom(ctx.client, move, body.placeId)
    : box.destination_place_id;
  if (!room) {
    throw new AppError('validation', 400, 'Choose the room this box goes to.', {
      reason: 'no_room',
    });
  }
  const thing = await liveThing(ctx.client, box.container_id);
  const was: Whereabouts = {
    location_id: thing.location_id,
    place_id: thing.place_id,
    container_id: thing.container_id,
  };
  // The ordinary move (D45): its checks (the room's location must be writable), its definer
  // across locations, and its `thing.move` rows, without an undo window of their own.
  await moveThings(ctx, { thingIds: [box.container_id], to: { placeId: room } }, null, {
    undoable: false,
  });
  await ctx.client.query(
    `UPDATE public.move_boxes
        SET state = 'unpacked', destination_place_id = $3,
            state_at = coalesce($4::timestamptz, now()), state_by = kept.current_user_id()
      WHERE move_id = $1 AND container_id = $2`,
    [box.move_id, box.container_id, room, opts.at?.toISOString() ?? null],
  );
  const after = (await findBox(ctx.client, box.move_id, box.container_id)) as BoxRecord;
  const now = await liveThing(ctx.client, box.container_id);
  await audited(ctx.tx, {
    locationId: move.location_id,
    actor: actorOf(ctx.scope),
    action: 'move_box.unpack',
    entity: { type: 'thing', id: box.container_id },
    before: { box: boxImage(box), at: was },
    after: {
      box: boxImage(after),
      at: { location_id: now.location_id, place_id: now.place_id, container_id: now.container_id },
    },
    rootThingId: box.container_id,
    subjects: [box.container_id],
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  return { box: boxView(after), changed: true };
}

export async function removeBox(ctx: WriteCtx, moveId: string, containerId: string) {
  const { move, box } = await writableBox(ctx, moveId, containerId);
  await ctx.client.query('DELETE FROM public.move_boxes WHERE move_id = $1 AND container_id = $2', [
    box.move_id,
    box.container_id,
  ]);
  await audited(ctx.tx, {
    locationId: move.location_id,
    actor: actorOf(ctx.scope),
    action: 'move_box.delete',
    entity: { type: 'thing', id: box.container_id },
    before: { box: boxImage(box) },
    after: null,
    rootThingId: box.container_id,
    subjects: [box.container_id],
    requestId: ctx.requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// Undo (D150)
// ---------------------------------------------------------------------------------------------

type Diff = {
  box?: { before?: BoxImage | null; after?: BoxImage | null };
  at?: { before?: Whereabouts | null; after?: Whereabouts | null };
};

/** The box row as the event left it, locked, or a conflict naming who changed it since. */
async function boxAsLeft(args: UndoArgs): Promise<{ was: BoxImage; left: BoxImage }> {
  const { client, event } = args;
  const diff = event.diff as Diff;
  const was = diff.box?.before;
  const left = diff.box?.after;
  if (!was || !left || !event.entityId) throw notFound();
  const { rows } = await client.query<{
    state: BoxState;
    destination_place_id: string | null;
    state_at: Date;
    status: MoveStatus;
  }>(
    `SELECT b.state, b.destination_place_id, b.state_at, m.status
       FROM public.move_boxes b JOIN public.moves m ON m.id = b.move_id
      WHERE b.move_id = $1 AND b.container_id = $2 FOR UPDATE OF b`,
    [left.move_id, event.entityId],
  );
  const now = rows[0];
  const changed =
    !now ||
    now.status !== 'active' ||
    now.state !== left.state ||
    now.destination_place_id !== left.destination_place_id ||
    now.state_at.toISOString() !== left.state_at;
  if (changed) {
    const by = await lastChangedBy(
      client,
      event.locationId,
      { type: 'thing', id: event.entityId },
      event.at,
    );
    throw undoConflict(['state'], by);
  }
  return { was, left };
}

async function restoreBox(args: UndoArgs, containerId: string, was: BoxImage) {
  await args.client.query(
    `UPDATE public.move_boxes
        SET state = $3, destination_place_id = $4, state_at = $5::timestamptz,
            state_by = kept.current_user_id()
      WHERE move_id = $1 AND container_id = $2`,
    [was.move_id, containerId, was.state, was.destination_place_id, was.state_at],
  );
}

async function undoBoxUpdate(args: UndoArgs): Promise<void> {
  const containerId = args.event.entityId as string;
  const { was, left } = await boxAsLeft(args);
  await restoreBox(args, containerId, was);
  await args.audit({
    action: 'move_box.update',
    entity: { type: 'thing', id: containerId },
    before: { box: left },
    after: { box: was },
    rootThingId: containerId,
    subjects: [containerId],
  });
}

async function undoBoxUnpack(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  const containerId = event.entityId as string;
  const { was, left } = await boxAsLeft(args);
  const diff = event.diff as Diff;
  const from = diff.at?.before;
  const to = diff.at?.after;
  if (!from || !to) throw notFound();
  // The box must still be where the unpack put it.
  const { rows } = await client.query<Whereabouts & { deleted: boolean }>(
    `SELECT location_id, place_id, container_id, deleted_at IS NOT NULL AS deleted
       FROM public.things WHERE id = $1`,
    [containerId],
  );
  const now = rows[0];
  if (
    !now ||
    now.deleted ||
    now.location_id !== to.location_id ||
    now.place_id !== to.place_id ||
    now.container_id !== to.container_id
  ) {
    const by = await lastChangedBy(
      client,
      to.location_id,
      { type: 'thing', id: containerId },
      event.at,
    );
    throw undoConflict(['place'], by);
  }
  const ctx: Ctx = {
    tx: args.tx,
    client: args.client,
    scope: args.scope,
    requestId: args.requestId,
    jobs: args.deps.jobs,
    files: args.deps.files,
  };
  // Back where it was, through the forward move's checks; its own rows are plain (the undo's
  // row is the box's, below).
  await moveBackForUndo(
    ctx,
    containerId,
    { locationId: from.location_id, placeId: from.place_id, containerId: from.container_id },
    {
      locationId: event.locationId,
      write: async (e) => {
        await audited(args.tx, e);
      },
    },
  );
  await restoreBox(args, containerId, was);
  await args.audit({
    action: 'move_box.unpack',
    entity: { type: 'thing', id: containerId },
    before: { box: left, at: to },
    after: { box: was, at: from },
    rootThingId: containerId,
    subjects: [containerId],
  });
}

let registered = false;
/** Registers the undo of a box's state change and of an unpack (audit/undo.ts). Idempotent. */
export function registerMovingUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('move_box.update', undoBoxUpdate);
  registerUndo('move_box.unpack', undoBoxUnpack);
}

/** The counts of a list of boxes (the web's board leads with them). */
export const countsOf = (boxes: readonly MoveBoxView[]): BoxCounts => countBoxes(boxes);
