import type pg from 'pg';
import { z } from 'zod';
import { audited, undoableEventIds } from '../audit/audited.js';
import {
  lastChangedBy,
  registerUndo,
  type UndoArgs,
  undoableUntil,
  undoConflict,
} from '../audit/undo.js';
import { assertClientId, encodeCursor, type PageRequest } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { enqueueReindex } from '../search/jobs.js';
import { type Ctx, requireRole, splitThing, writableThing } from '../things/service.js';

// The box check (plan T17; D10, D40, D45, D175; screens §6 and §8; Q25). Someone opens a box and
// counts what is directly inside it: nested boxes are one line each, checked as a unit, and what
// is inside them keeps its own last-seen date (D45). The same service answers
// `POST /api/v1/things/:id/box-check` and the `box_check` sync op (T14), in the caller's scoped
// transaction. The web contract is apps/web/src/api/capture/types.ts `BoxCheckBody` /
// `BoxCheckResult`.
//
// Each line is a direct child of the box, with the count the phone expected and the count found:
// - found ≥ expected: seen (`last_seen_at = now()`, "not here" cleared);
// - found = 0: not here (`location_uncertain`);
// - in between ("found 2 of 3"): the row is split (step 2's splitThing, D10: the new row keeps
//   the purchase line), the found part stays and is seen, and the missing part is the new row,
//   marked not here. When what's missing is the whole row as it is now (it shrank since the
//   phone counted), the row is simply not here.
// `foundElsewhereIds`: things of the same location found in the box that weren't listed; they
// move into it (a plain in-location move, D45) and are seen. They are stored as lines expected 0.
//
// One `box.check` audit event, as the caller, with every line's thing (and the split-off rows)
// as subjects, undoable for 7 days (Q23): the undo restores each thing's seen date, "not here",
// quantity and place, and trashes the split-off rows, as long as nothing changed them since.
// splitThing writes its own `thing.split` / `thing.create` events, as a split from the thing's
// page does, so each timeline says where the new row came from.

export const MAX_LINES = 500;

const Decimal = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'a decimal of at most 3 places');

export const BoxCheckBody = z.strictObject({
  id: z.uuid(),
  lines: z
    .array(z.strictObject({ thingId: z.uuid(), expectedQty: Decimal, foundQty: Decimal }))
    .max(MAX_LINES),
  foundElsewhereIds: z.array(z.uuid()).max(200).optional(),
});
export type BoxCheckBody = z.infer<typeof BoxCheckBody>;

export const BoxCheckResultSchema = z.object({
  boxCheckId: z.uuid(),
  seen: z.array(z.uuid()),
  notHere: z.array(z.uuid()),
  split: z.array(z.object({ originalId: z.uuid(), newId: z.uuid() })),
  movedIn: z.array(z.uuid()),
  undo: z.object({ eventId: z.uuid(), until: z.string() }).optional(),
});
export type BoxCheckResult = z.infer<typeof BoxCheckResultSchema>;

export const BoxCheckSummarySchema = z.object({
  id: z.uuid(),
  at: z.string(),
  by: z.object({ displayName: z.string() }),
  seen: z.number(),
  notHere: z.number(),
  split: z.number(),
  movedIn: z.number(),
});

/** What the undo puts back, per thing. */
type State = {
  last_seen_at: string | null;
  location_uncertain: boolean;
  quantity: string;
  place_id: string | null;
  container_id: string | null;
};

type Row = State & { id: string; location_id: string; deleted_at: Date | null };

const STATE_COLUMNS = `id, location_id, deleted_at, last_seen_at, location_uncertain,
                       quantity::text AS quantity, place_id, container_id`;

async function statesOf(client: pg.ClientBase, ids: readonly string[]): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<Omit<Row, 'last_seen_at'> & { last_seen_at: Date | null }>(
    `SELECT ${STATE_COLUMNS} FROM public.things WHERE id = ANY ($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...ids]],
  );
  return new Map(
    rows.map((r) => [r.id, { ...r, last_seen_at: r.last_seen_at?.toISOString() ?? null }]),
  );
}

const stateOf = (r: Row): State => ({
  last_seen_at: r.last_seen_at,
  location_uncertain: r.location_uncertain,
  quantity: r.quantity,
  place_id: r.place_id,
  container_id: r.container_id,
});

export type BoxCheckOptions = {
  /** `op` (T14) checked the client id against its own 90-day window (Q2). */
  via: 'online' | 'op';
};

/** POST /api/v1/things/:id/box-check, and the `box_check` op. */
export async function boxCheck(
  ctx: Ctx,
  containerId: string,
  body: BoxCheckBody,
  opts: BoxCheckOptions = { via: 'online' },
): Promise<BoxCheckResult> {
  const { client, tx, scope } = ctx;
  const boxId = containerId.toLowerCase();
  const box = await writableThing(client, boxId, 'things.mark-seen');
  await requireRole(client, box.location_id, 'labels.use');
  const id = opts.via === 'online' ? assertClientId(body.id) : body.id.toLowerCase();

  const lines = body.lines.map((l) => ({
    thingId: l.thingId.toLowerCase(),
    expected: Number(l.expectedQty),
    found: Number(l.foundQty),
    expectedQty: l.expectedQty,
    foundQty: l.foundQty,
  }));
  const lineIds = lines.map((l) => l.thingId);
  const elsewhere = [...new Set((body.foundElsewhereIds ?? []).map((x) => x.toLowerCase()))];
  if (new Set(lineIds).size !== lineIds.length) throw invalid('lines: each thing once.');
  if (elsewhere.some((x) => lineIds.includes(x) || x === boxId)) {
    throw invalid('foundElsewhereIds: things that are not already lines, nor the box itself.');
  }
  if (lines.length === 0 && elsewhere.length === 0) throw invalid('Nothing was counted.');

  const before = await statesOf(client, [...lineIds, ...elsewhere]);
  for (const l of lines) {
    const r = before.get(l.thingId);
    if (!r || r.deleted_at) throw notFound();
    if (r.container_id !== boxId) {
      throw invalid('Only what is directly in the box can be checked; reload and count again.');
    }
  }
  for (const x of elsewhere) {
    const r = before.get(x);
    // Another location's thing, or one the caller can't see, is the same 404 as a random id.
    if (!r || r.deleted_at || r.location_id !== box.location_id) throw notFound();
  }

  const result: BoxCheckResult = { boxCheckId: id, seen: [], notHere: [], split: [], movedIn: [] };
  const seen: string[] = [];
  const notHere: string[] = [];
  for (const l of lines) {
    const r = before.get(l.thingId) as Row;
    const missing = l.expected - l.found;
    if (l.expected === 0 || missing <= 0) {
      seen.push(l.thingId);
      result.seen.push(l.thingId);
    } else if (l.found === 0 || missing >= Number(r.quantity)) {
      notHere.push(l.thingId);
      result.notHere.push(l.thingId);
    } else {
      const part = await splitThing(ctx, l.thingId, { quantity: missing }, null);
      seen.push(l.thingId);
      notHere.push(part.newId);
      result.split.push(part);
    }
  }
  if (seen.length > 0) {
    await client.query(
      `UPDATE public.things SET last_seen_at = now(), location_uncertain = false
        WHERE id = ANY ($1::uuid[])`,
      [seen],
    );
  }
  if (notHere.length > 0) {
    await client.query(
      'UPDATE public.things SET location_uncertain = true WHERE id = ANY ($1::uuid[])',
      [notHere],
    );
  }
  const moved = elsewhere.filter((x) => (before.get(x) as Row).container_id !== boxId);
  if (elsewhere.length > 0) {
    // A plain move within the location (D45); a loop is refused by the things trigger (409).
    await client.query(
      `UPDATE public.things SET container_id = $2, place_id = NULL, last_seen_at = now(),
                                location_uncertain = false
        WHERE id = ANY ($1::uuid[])`,
      [elsewhere, boxId],
    );
    result.movedIn.push(...elsewhere);
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.things WHERE container_id = ANY ($1::uuid[]) LIMIT 1',
      [moved],
    );
    if (rowCount) await enqueueReindex(ctx.jobs, client, box.location_id);
  }

  await client.query(
    `INSERT INTO public.box_checks (id, location_id, container_id, checked_by, checked_at)
     VALUES ($1, $2, $3, kept.current_user_id(), now())`,
    [id, box.location_id, boxId],
  );
  const lineRows = [
    ...lines.map((l) => [l.thingId, l.expectedQty, l.foundQty]),
    ...elsewhere.map((x) => [x, '0', (before.get(x) as Row).quantity]),
  ];
  await client.query(
    `INSERT INTO public.box_check_lines (box_check_id, location_id, thing_id, expected_qty,
                                         found_qty)
     SELECT $1, $2, x.thing_id, x.expected::numeric, x.found::numeric
       FROM unnest($3::uuid[], $4::text[], $5::text[]) x(thing_id, expected, found)`,
    [
      id,
      box.location_id,
      lineRows.map((r) => r[0]),
      lineRows.map((r) => r[1]),
      lineRows.map((r) => r[2]),
    ],
  );

  const touched = [...lineIds, ...elsewhere, ...result.split.map((s) => s.newId)];
  const after = await statesOf(client, touched);
  const until = undoableUntil();
  await audited(tx, {
    locationId: box.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'box.check',
    entity: { type: 'thing', id: boxId },
    before: {
      state: Object.fromEntries(
        [...lineIds, ...elsewhere].map((x) => [x, stateOf(before.get(x) as Row)]),
      ),
    },
    after: {
      state: Object.fromEntries(touched.map((x) => [x, stateOf(after.get(x) as Row)])),
      box_check_id: id,
      split: result.split,
      moved_in: moved,
    },
    rootThingId: boxId,
    subjects: [boxId, ...touched],
    requestId: ctx.requestId,
    undoableUntil: until,
  });
  const eventId = undoableEventIds(tx).at(-1);
  if (eventId) result.undo = { eventId, until: until.toISOString() };
  return result;
}

/** GET /api/v1/things/:id/box-checks?cursor: the box's checks, newest first. */
export async function listBoxChecks(
  client: pg.ClientBase,
  containerId: string,
  page: PageRequest<[string, string]>,
): Promise<{ items: z.infer<typeof BoxCheckSummarySchema>[]; next_cursor: string | null }> {
  const { rowCount } = await client.query('SELECT 1 FROM public.things WHERE id = $1', [
    containerId,
  ]);
  if (!rowCount) throw notFound();
  const after = page.after;
  const { rows } = await client.query<{
    id: string;
    checked_at: Date;
    display_name: string | null;
    seen: number;
    not_here: number;
    split: number;
    moved_in: number;
  }>(
    `SELECT b.id, b.checked_at, up.display_name,
            count(*) FILTER (WHERE l.expected_qty > 0 AND l.found_qty >= l.expected_qty)::int
              AS seen,
            count(*) FILTER (WHERE l.expected_qty > 0 AND l.found_qty = 0)::int AS not_here,
            count(*) FILTER (WHERE l.found_qty > 0 AND l.found_qty < l.expected_qty)::int
              AS split,
            count(*) FILTER (WHERE l.expected_qty = 0 AND l.found_qty > 0)::int AS moved_in
       FROM public.box_checks b
       LEFT JOIN public.box_check_lines l ON l.box_check_id = b.id
       LEFT JOIN public.user_profiles up ON up.user_id = b.checked_by
      WHERE b.container_id = $1
        AND ($2::timestamptz IS NULL OR (b.checked_at, b.id) < ($2::timestamptz, $3::uuid))
      GROUP BY b.id, b.checked_at, up.display_name
      ORDER BY b.checked_at DESC, b.id DESC
      LIMIT $4`,
    [containerId, after?.[0] ?? null, after?.[1] ?? null, page.limit + 1],
  );
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: items.map((r) => ({
      id: r.id,
      at: r.checked_at.toISOString(),
      by: { displayName: r.display_name ?? '' },
      seen: r.seen,
      notHere: r.not_here,
      split: r.split,
      movedIn: r.moved_in,
    })),
    next_cursor:
      rows.length > page.limit && last
        ? encodeCursor([last.checked_at.toISOString(), last.id])
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Undo (D150, Q23)
// ---------------------------------------------------------------------------------------------

type Diff = {
  state?: { before?: Record<string, State> | null; after?: Record<string, State> | null };
  split?: { after?: { originalId: string; newId: string }[] | null };
};

const same = (a: State, b: State) =>
  a.last_seen_at === b.last_seen_at &&
  a.location_uncertain === b.location_uncertain &&
  Number(a.quantity) === Number(b.quantity) &&
  a.place_id === b.place_id &&
  a.container_id === b.container_id;

async function undoBoxCheck(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  const diff = event.diff as Diff;
  const was = diff.state?.before ?? {};
  const left = diff.state?.after ?? {};
  const splits = diff.split?.after ?? [];
  const ids = Object.keys(left);
  const now = await statesOf(client, ids);
  const changed = ids.filter((x) => {
    const r = now.get(x);
    return !r || r.deleted_at !== null || !same(stateOf(r), left[x] as State);
  });
  if (changed.length > 0) {
    const by = await lastChangedBy(
      client,
      event.locationId,
      { type: 'thing', id: changed[0] as string },
      event.at,
    );
    throw undoConflict(['things'], by);
  }
  for (const s of splits) {
    await client.query(
      'UPDATE public.things SET deleted_at = now(), trash_batch_id = uuidv7() WHERE id = $1',
      [s.newId],
    );
  }
  for (const [thingId, st] of Object.entries(was)) {
    await client.query(
      `UPDATE public.things
          SET last_seen_at = $2, location_uncertain = $3, quantity = $4::numeric,
              place_id = $5, container_id = $6
        WHERE id = $1`,
      [thingId, st.last_seen_at, st.location_uncertain, st.quantity, st.place_id, st.container_id],
    );
  }
  await args.audit({
    action: event.action,
    entity: { type: 'thing', id: event.entityId },
    before: { state: left },
    after: { state: was, trashed: splits.map((s) => s.newId) },
    ...(event.rootThingId ? { rootThingId: event.rootThingId } : {}),
    subjects: [...new Set([...ids, ...Object.keys(was)])],
  });
}

let registered = false;
/** Registers the `box.check` undo (audit/undo.ts). Idempotent. */
export function registerBoxCheckUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('box.check', undoBoxCheck);
}
