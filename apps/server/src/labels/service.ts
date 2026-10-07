import { isSheet, LABEL_STOCKS, labelStock, newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { assertClientId, encodeCursor, type PageRequest } from '../http/conventions.js';
import { AppError, invalid, notFound, pgErrorOf } from '../http/errors.js';
import { SHORT_ID_TRIES } from '../places/short-id.js';
import { type Ctx, requireRole } from '../things/service.js';

// Label batches (plan T16; D43, D44, D45, D97, D137, D172, D175, D185; screens §6; Q28, Q29).
// The web contract is apps/web/src/api/capture/types.ts "labels (T16)".
//
// A batch is one print job: which codes, on which stock, from which cell. The sheet itself is the
// web's (T28: print-styled HTML and phone PNGs); the server hands out the codes and remembers
// them, so a reprint is the same codes (D45).
//
// - `things` / `places`: the listed ones (at most 500), or `unprinted` (Q28): every live thing
//   (or place) in the place's subtree, or the location, none of whose codes was ever printed. A
//   quantity row has one label (D137). A listed thing that isn't a live thing of this location
//   with a code is excluded and counted: `pending` when the caller can't see it at all (an
//   offline capture not synced yet looks exactly like that, and so does anyone else's id, which
//   keeps this from telling the two apart), `other` when it is a visible thing that can't be
//   labelled here (trashed, or in another location). An `unprinted` run past 1,000 labels (the
//   batch's cap) prints the first 1,000 and counts the rest as `other`: they stay unprinted.
// - `blank`: 1–500 new blank codes, each tried as `randomShortCode()` with INSERT … ON CONFLICT
//   DO NOTHING (8 tries each, places/short-id.ts), under the 1,000-unclaimed cap per location
//   (§3.1b; the 0042 trigger enforces it, this answers 409 `blank_cap_reached` first).
// - "Printed OK?" (`printed`) sets `printed_at` on the batch's codes, keeping the first one, and
//   the batch's `printed_confirmed_at`, once; a second confirmation changes and audits nothing.

export const MAX_LISTED = 500;
export const MAX_BLANKS = 500;
/** label_batches_code_count_chk. */
export const MAX_BATCH = 1000;
/** §3.1b, D172. */
export const BLANK_CAP = 1000;

const Ids = z.array(z.uuid()).min(1).max(MAX_LISTED);

export const CreateBatchBody = z.strictObject({
  id: z.uuid().optional(),
  locationId: z.uuid(),
  kind: z.enum(['things', 'places', 'blank']),
  thingIds: Ids.optional(),
  placeIds: Ids.optional(),
  unprinted: z.strictObject({ placeId: z.uuid().optional() }).optional(),
  blankCount: z.number().int().min(1).max(MAX_BLANKS).optional(),
  stock: z.string().refine((s) => LABEL_STOCKS.some((x) => x.key === s), 'an unknown stock'),
  startCell: z.number().int().min(1).max(200).optional(),
  /** T28's preview: 200 LabelBatchPreview, nothing saved and no blank code allocated. */
  dryRun: z.boolean().optional(),
});
export type CreateBatchBody = z.infer<typeof CreateBatchBody>;

export const LabelCellSchema = z.object({
  code: z.string(),
  url: z.string(),
  kind: z.enum(['thing', 'place', 'blank']),
  name: z.string().optional(),
  path: z.string().optional(),
  targetId: z.uuid().optional(),
});

export const LabelBatchSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  kind: z.enum(['things', 'places', 'blank']),
  stock: z.string(),
  startCell: z.number(),
  createdAt: z.string(),
  printedConfirmedAt: z.string().nullable(),
  labels: z.array(LabelCellSchema),
});
export type LabelBatch = z.infer<typeof LabelBatchSchema>;

export const CreateBatchResultSchema = z.object({
  batch: LabelBatchSchema,
  excluded: z.object({ pending: z.number(), other: z.number() }),
});

/** 200 for a `dryRun` create: the labels in print order; a blank sheet has none yet, and
 * `blank` says how many it would make. */
export const LabelBatchPreviewSchema = z.object({
  labels: z.array(LabelCellSchema),
  blank: z.number(),
  excluded: z.object({ pending: z.number(), other: z.number() }),
});
export type LabelBatchPreview = z.infer<typeof LabelBatchPreviewSchema>;

export const SummarySchema = z.object({ unprinted: z.number(), blankUnclaimed: z.number() });

const actor = (userId: string) => ({ type: 'user' as const, id: userId });

/** A label's link (D120): the host is only for the system camera; the app ignores it. */
export const labelUrl = (publicUrl: string, code: string) =>
  `${publicUrl.replace(/\/+$/, '')}/l/${code}`;

// ---------------------------------------------------------------------------------------------
// Reading a batch
// ---------------------------------------------------------------------------------------------

type BatchRow = {
  id: string;
  location_id: string;
  kind: 'things' | 'places' | 'blank';
  stock: string;
  start_cell: number;
  created_at: Date;
  printed_confirmed_at: Date | null;
};

const BATCH_COLUMNS = `b.id, b.location_id, b.kind, b.stock, b.start_cell, b.created_at,
                       b.printed_confirmed_at`;

type CellRow = {
  batch_id: string;
  code: string;
  thing_id: string | null;
  place_id: string | null;
  name: string | null;
  path: string | null;
};

/** The labels of `batches`, in print order: a code's thing or place as it is now, when the
 * caller can still see it (a thing moved out of sight prints as its code alone). */
async function cellsOf(
  client: pg.ClientBase,
  publicUrl: string,
  batches: readonly BatchRow[],
): Promise<Map<string, LabelBatch['labels']>> {
  const out = new Map<string, LabelBatch['labels']>(batches.map((b) => [b.id, []]));
  if (batches.length === 0) return out;
  const { rows } = await client.query<CellRow>(
    `SELECT c.batch_id, ${CELL_COLUMNS}
       FROM public.label_batch_codes c ${CELL_JOINS}
      WHERE c.batch_id = ANY ($1::uuid[])
      ORDER BY c.batch_id, c.sort`,
    [batches.map((b) => b.id)],
  );
  const kindOf = new Map(batches.map((b) => [b.id, b.kind]));
  for (const r of rows) {
    out.get(r.batch_id)?.push(cellOf(publicUrl, kindOf.get(r.batch_id) ?? 'things', r));
  }
  return out;
}

/** The labels `codes` would print as, in order (a preview, T28). */
async function previewCells(
  client: pg.ClientBase,
  publicUrl: string,
  kind: 'things' | 'places',
  codes: readonly string[],
): Promise<LabelBatch['labels']> {
  if (codes.length === 0) return [];
  const { rows } = await client.query<CellRow>(
    `SELECT ${CELL_COLUMNS}
       FROM unnest($1::text[]) WITH ORDINALITY c(code, n) ${CELL_JOINS}
      ORDER BY c.n`,
    [[...codes]],
  );
  return rows.map((r) => cellOf(publicUrl, kind, r));
}

/** A cell's code, target, name and path (outermost first, " › "; a thing's place chain and
 * containers, `place_path`; a place's parent chain). */
const CELL_COLUMNS = `c.code::text AS code, t.id AS thing_id, p.id AS place_id,
       coalesce(t.name, p.name) AS name,
       CASE WHEN t.id IS NOT NULL THEN t.place_path
            WHEN p.id IS NOT NULL THEN
              (SELECT string_agg(e->>'name', ' › ' ORDER BY x.n)
                 FROM jsonb_array_elements(kept.path_of(p.parent_id, NULL))
                      WITH ORDINALITY x(e, n))
       END AS path`;
const CELL_JOINS = `
       LEFT JOIN public.short_ids s ON s.code = c.code
       LEFT JOIN public.things t ON t.id = s.thing_id AND t.deleted_at IS NULL
       LEFT JOIN public.places p ON p.id = s.place_id AND p.deleted_at IS NULL`;

function cellOf(
  publicUrl: string,
  batchKind: BatchRow['kind'],
  r: Omit<CellRow, 'batch_id'>,
): LabelBatch['labels'][number] {
  const cell: LabelBatch['labels'][number] = {
    code: r.code,
    url: labelUrl(publicUrl, r.code),
    kind: batchKind === 'blank' ? 'blank' : batchKind === 'places' ? 'place' : 'thing',
  };
  if (batchKind !== 'blank') {
    const target = r.thing_id ?? r.place_id;
    if (target) cell.targetId = target;
    if (r.name !== null && target) cell.name = r.name;
    if (r.path && target) cell.path = r.path;
  }
  return cell;
}

function batchOf(b: BatchRow, labels: LabelBatch['labels']): LabelBatch {
  return {
    id: b.id,
    locationId: b.location_id,
    kind: b.kind,
    stock: b.stock,
    startCell: b.start_cell,
    createdAt: b.created_at.toISOString(),
    printedConfirmedAt: b.printed_confirmed_at?.toISOString() ?? null,
    labels,
  };
}

/** GET /api/v1/labels/batches/:id: a batch the caller can see, else 404. */
export async function getBatch(
  client: pg.ClientBase,
  publicUrl: string,
  id: string,
): Promise<LabelBatch> {
  const { rows } = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM public.label_batches b WHERE b.id = $1`,
    [id],
  );
  const b = rows[0];
  if (!b) throw notFound();
  return batchOf(b, (await cellsOf(client, publicUrl, [b])).get(b.id) ?? []);
}

/** GET /api/v1/labels/batches?locationId&cursor: newest first. */
export async function listBatches(
  client: pg.ClientBase,
  publicUrl: string,
  locationId: string | null,
  page: PageRequest<[string, string]>,
): Promise<{ items: LabelBatch[]; next_cursor: string | null }> {
  const after = page.after;
  const { rows } = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM public.label_batches b
      WHERE ($1::uuid IS NULL OR b.location_id = $1::uuid)
        AND ($2::timestamptz IS NULL OR (b.created_at, b.id) < ($2::timestamptz, $3::uuid))
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $4`,
    [locationId, after?.[0] ?? null, after?.[1] ?? null, page.limit + 1],
  );
  const items = rows.slice(0, page.limit);
  const cells = await cellsOf(client, publicUrl, items);
  const last = items.at(-1);
  return {
    items: items.map((b) => batchOf(b, cells.get(b.id) ?? [])),
    next_cursor:
      rows.length > page.limit && last
        ? encodeCursor([last.created_at.toISOString(), last.id])
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Making a batch
// ---------------------------------------------------------------------------------------------

type Picked = { codes: string[]; subjects: string[]; pending: number; other: number };

/** A live place of the location, or 404. */
async function requirePlace(client: pg.ClientBase, locationId: string, placeId: string) {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.places WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL',
    [placeId, locationId],
  );
  if (!rowCount) throw notFound();
}

/** Listed things or places: their primary codes, in the order given, and what was left out. */
async function pickListed(
  client: pg.ClientBase,
  locationId: string,
  table: 'things' | 'places',
  ids: readonly string[],
): Promise<Picked> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  const col = table === 'things' ? 'thing_id' : 'place_id';
  const { rows } = await client.query<{ id: string; code: string | null; here: boolean }>(
    `SELECT x.id, s.code::text AS code,
            (x.location_id = $2 AND x.deleted_at IS NULL) AS here
       FROM unnest($1::uuid[]) WITH ORDINALITY u(id, n)
       JOIN public.${table} x ON x.id = u.id
       LEFT JOIN public.short_ids s
              ON s.${col} = x.id AND s.state = 'assigned' AND s.is_primary
      ORDER BY u.n`,
    [unique, locationId],
  );
  const picked: Picked = { codes: [], subjects: [], pending: 0, other: 0 };
  const seen = new Set(rows.map((r) => r.id));
  picked.pending = unique.filter((id) => !seen.has(id)).length;
  for (const r of rows) {
    if (!r.here) picked.other += 1;
    else if (!r.code) picked.pending += 1;
    else {
      picked.codes.push(r.code);
      if (table === 'things') picked.subjects.push(r.id);
    }
  }
  return picked;
}

/** Q28: every live thing (or place) under `placeId` (or in the location) none of whose codes was
 * ever printed, in place order. */
async function pickUnprinted(
  client: pg.ClientBase,
  locationId: string,
  table: 'things' | 'places',
  placeId: string | null,
): Promise<Picked> {
  if (placeId) await requirePlace(client, locationId, placeId);
  const unprinted = (col: string, alias: string) =>
    `NOT EXISTS (SELECT 1 FROM public.short_ids x
                  WHERE x.${col} = ${alias}.id AND x.state = 'assigned'
                    AND x.printed_at IS NOT NULL)`;
  const subtree = `WITH RECURSIVE sub(id) AS (
      SELECT p.id FROM public.places p
       WHERE p.location_id = $1 AND p.deleted_at IS NULL
         AND ($2::uuid IS NULL AND p.parent_id IS NULL OR p.id = $2::uuid)
      UNION
      SELECT p.id FROM public.places p JOIN sub ON p.parent_id = sub.id
       WHERE p.deleted_at IS NULL)`;
  const sql =
    table === 'things'
      ? `${subtree},
         inside(id) AS (
           SELECT t.id FROM public.things t
            WHERE t.location_id = $1 AND t.deleted_at IS NULL
              AND ($2::uuid IS NULL OR t.place_id IN (SELECT id FROM sub))
           UNION
           SELECT t.id FROM public.things t JOIN inside i ON t.container_id = i.id
            WHERE t.deleted_at IS NULL)
         SELECT t.id, s.code::text AS code
           FROM inside i
           JOIN public.things t ON t.id = i.id
           LEFT JOIN public.short_ids s
                  ON s.thing_id = t.id AND s.state = 'assigned' AND s.is_primary
          WHERE ${unprinted('thing_id', 't')}
          ORDER BY t.place_path COLLATE "und-x-icu", t.name COLLATE "und-x-icu", t.id`
      : `${subtree}
         SELECT p.id, s.code::text AS code
           FROM sub JOIN public.places p ON p.id = sub.id
           JOIN public.short_ids s ON s.place_id = p.id AND s.state = 'assigned' AND s.is_primary
          WHERE NOT p.is_unplaced AND ${unprinted('place_id', 'p')}
          ORDER BY p.name COLLATE "und-x-icu", p.id`;
  const { rows: all } = await client.query<{ id: string; code: string | null }>(sql, [
    locationId,
    placeId,
  ]);
  // A thing with no code yet is `pending` (screens §6).
  const rows = all.filter((r): r is { id: string; code: string } => r.code !== null);
  const kept = rows.slice(0, MAX_BATCH);
  return {
    codes: kept.map((r) => r.code),
    subjects: table === 'things' ? kept.map((r) => r.id) : [],
    pending: all.length - rows.length,
    other: rows.length - kept.length,
  };
}

/** `count` new blank codes in the location, under the cap. */
/** 409 `blank_cap_reached` unless `count` more blanks fit under the location's cap. */
async function requireBlankRoom(client: pg.ClientBase, locationId: string, count: number) {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.short_ids WHERE location_id = $1 AND state = 'blank'`,
    [locationId],
  );
  if ((rows[0]?.n ?? 0) + count > BLANK_CAP) throw blankCapReached();
}

async function makeBlanks(client: pg.ClientBase, locationId: string, count: number) {
  await requireBlankRoom(client, locationId, count);
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code: string | undefined;
    for (let tries = 0; tries < SHORT_ID_TRIES && !code; tries++) {
      const res = await client.query<{ code: string }>(
        `INSERT INTO public.short_ids (code, location_id, state, is_primary)
         VALUES ($1, $2, 'blank', false)
         ON CONFLICT (code) DO NOTHING RETURNING code::text AS code`,
        [randomShortCode(), locationId],
      );
      code = res.rows[0]?.code;
    }
    if (!code) throw new Error(`no free short code after ${SHORT_ID_TRIES} tries`);
    codes.push(code);
  }
  return codes;
}

const blankCapReached = () =>
  new AppError('blank_cap_reached', 409, 'Claim some of the blank labels before printing more.');

export type CreateBatchResult = {
  batch: LabelBatch;
  excluded: { pending: number; other: number };
};

/** POST /api/v1/labels/batches. */
export async function createBatch(
  ctx: Ctx,
  publicUrl: string,
  body: CreateBatchBody,
): Promise<CreateBatchResult | LabelBatchPreview> {
  const { client, tx, scope } = ctx;
  const locationId = body.locationId.toLowerCase();
  await requireRole(client, locationId, 'labels.use');
  const stock = labelStock(body.stock);
  const startCell = body.startCell ?? 1;
  const perPage = stock.cols * stock.rows;
  if (isSheet(stock) ? startCell > perPage : startCell !== 1) {
    throw invalid(`startCell: 1 to ${perPage} on this stock.`);
  }
  const listed = body.kind === 'places' ? body.placeIds : body.thingIds;
  if (body.kind === 'blank') {
    if (!body.blankCount || body.thingIds || body.placeIds || body.unprinted) {
      throw invalid('A blank sheet takes blankCount, and nothing else to label.');
    }
  } else {
    const other = body.kind === 'places' ? body.thingIds : body.placeIds;
    if (!!listed === !!body.unprinted || other || body.blankCount !== undefined) {
      throw invalid(
        `Label ${body.kind} by ${body.kind === 'places' ? 'placeIds' : 'thingIds'} or unprinted, one of them.`,
      );
    }
  }

  let picked: Picked;
  try {
    if (body.kind === 'blank' && body.dryRun) {
      await requireBlankRoom(client, locationId, body.blankCount as number);
      picked = { codes: [], subjects: [], pending: 0, other: 0 };
    } else if (body.kind === 'blank') {
      const codes = await makeBlanks(client, locationId, body.blankCount as number);
      picked = { codes, subjects: [], pending: 0, other: 0 };
    } else if (listed) {
      picked = await pickListed(client, locationId, body.kind, listed);
    } else {
      picked = await pickUnprinted(
        client,
        locationId,
        body.kind,
        body.unprinted?.placeId?.toLowerCase() ?? null,
      );
    }
  } catch (err) {
    if (pgErrorOf(err)?.constraint === 'short_ids_blank_cap') throw blankCapReached();
    throw err;
  }
  const excluded = { pending: picked.pending, other: picked.other };
  if (body.dryRun) {
    // T28's preview: nothing saved, no blank allocated, nothing audited.
    return body.kind === 'blank'
      ? { labels: [], blank: body.blankCount as number, excluded }
      : {
          labels: await previewCells(client, publicUrl, body.kind, picked.codes),
          blank: 0,
          excluded,
        };
  }
  if (picked.codes.length === 0) {
    throw new AppError(
      'validation',
      400,
      'Nothing here can be labelled yet: what is left is waiting to sync, or already printed.',
      { excluded },
    );
  }

  const id = body.id ? assertClientId(body.id) : newId();
  await client.query(
    `INSERT INTO public.label_batches (id, location_id, kind, stock, start_cell, code_count,
                                       created_by)
     VALUES ($1, $2, $3, $4, $5, $6, kept.current_user_id())`,
    [id, locationId, body.kind, stock.key, startCell, picked.codes.length],
  );
  await client.query(
    `INSERT INTO public.label_batch_codes (batch_id, location_id, code, sort)
     SELECT $1, $2, c, n::int FROM unnest($3::text[]) WITH ORDINALITY u(c, n)`,
    [id, locationId, picked.codes],
  );
  await audited(tx, {
    locationId,
    actor: actor(scope.userId),
    action: 'label_batch.create',
    entity: { type: 'label_batch', id },
    after: {
      kind: body.kind,
      stock: stock.key,
      start_cell: startCell,
      code_count: picked.codes.length,
      ...(body.unprinted ? { unprinted: true } : {}),
    },
    requestId: ctx.requestId,
  });
  return { batch: await getBatch(client, publicUrl, id), excluded };
}

/** POST /api/v1/labels/batches/:id/printed ("Printed OK?"): idempotent, the first time kept. */
export async function markPrinted(ctx: Ctx, publicUrl: string, id: string): Promise<LabelBatch> {
  const { client, tx, scope } = ctx;
  const { rows } = await client.query<{ location_id: string; printed_confirmed_at: Date | null }>(
    'SELECT location_id, printed_confirmed_at FROM public.label_batches WHERE id = $1',
    [id],
  );
  const b = rows[0];
  if (!b) throw notFound();
  await requireRole(client, b.location_id, 'labels.use');
  if (!b.printed_confirmed_at) {
    await client.query(
      `UPDATE public.short_ids SET printed_at = coalesce(printed_at, now())
        WHERE code IN (SELECT code FROM public.label_batch_codes WHERE batch_id = $1)`,
      [id],
    );
    await client.query(
      'UPDATE public.label_batches SET printed_confirmed_at = now() WHERE id = $1',
      [id],
    );
    const { rows: things } = await client.query<{ id: string }>(
      `SELECT DISTINCT s.thing_id AS id FROM public.label_batch_codes c
         JOIN public.short_ids s ON s.code = c.code
        WHERE c.batch_id = $1 AND s.thing_id IS NOT NULL AND s.location_id = $2`,
      [id, b.location_id],
    );
    await audited(tx, {
      locationId: b.location_id,
      actor: actor(scope.userId),
      action: 'labels.printed',
      entity: { type: 'label_batch', id },
      before: { printed_confirmed_at: null },
      after: { printed_confirmed_at: true },
      subjects: things.map((t) => t.id),
      requestId: ctx.requestId,
    });
  }
  return getBatch(client, publicUrl, id);
}

/** GET /api/v1/labels/summary?locationId: Home's checklist and the labels screen; across every
 * visible location when none is given. The route checks the location and its module. */
export async function labelSummary(
  client: pg.ClientBase,
  locationId: string | null,
): Promise<{ unprinted: number; blankUnclaimed: number }> {
  const { rows } = await client.query<{ unprinted: number; blank: number }>(
    `SELECT
       (SELECT count(*)::int FROM public.things t
         WHERE t.deleted_at IS NULL AND ($1::uuid IS NULL OR t.location_id = $1::uuid)
           AND EXISTS (SELECT 1 FROM public.short_ids s
                        WHERE s.thing_id = t.id AND s.state = 'assigned')
           AND NOT EXISTS (SELECT 1 FROM public.short_ids s
                            WHERE s.thing_id = t.id AND s.state = 'assigned'
                              AND s.printed_at IS NOT NULL)) AS unprinted,
       (SELECT count(*)::int FROM public.short_ids s
         WHERE s.state = 'blank' AND ($1::uuid IS NULL OR s.location_id = $1::uuid)) AS blank`,
    [locationId],
  );
  return { unprinted: rows[0]?.unprinted ?? 0, blankUnclaimed: rows[0]?.blank ?? 0 };
}
