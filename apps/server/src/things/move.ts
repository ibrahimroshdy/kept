import { can } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { type AuditEventInput, auditedMany } from '../audit/audited.js';
import { undoableUntil } from '../audit/undo.js';
import { lockBlobKeys } from '../files/blob-locks.js';
import { AppError, forbidden, invalid, notFound, pgErrorOf } from '../http/errors.js';
import { callerMembership } from '../locations/access.js';
import { enqueueReindex } from '../search/jobs.js';
import {
  type Ctx,
  liveThing,
  requireRole,
  requireThingVersion,
  splitThing,
  writableThing,
} from './service.js';
import { MoveTarget } from './validate.js';

// Moves (plan T15; D45, D118, D161, D177; engineering spec §6.1, §7.4, §7.5; plan Q13), in the
// shapes of the web contract (apps/web/src/api/inventory/types.ts: MovePreviewBody, MovePreview,
// MoveBody, MoveResult, EmptyIntoBody):
//
// - Within one location a move is a plain UPDATE under RLS: the moved things get their new place
//   or container, are seen now and no longer "not here"; what is inside them follows through its
//   own container key and keeps its last-seen date (D45).
// - Into another location it goes through kept.move_things() (0021, 0024), which moves the things
//   with everything inside them, re-homes attachments, drops links that would cross locations,
//   writes the sync tombstones in each source location (§7.4) and, across owner accounts, maps
//   the registries (types with their chain, brands, tags, vendors, people by name only) and copies
//   the purchase line with its receipts (Q13, D161). The definer writes no audit rows; this does.
//
// Audit (§7.5, D45): one `thing.move` per thing the caller moved, whose diff holds `location_id`
// (when it changed), `place_id`, `container_id` and `path` (the breadcrumb's names), with
// `undoableUntil()` so things/undo.ts can put it back, and the thing plus everything inside it as
// subjects, so the contents' timelines show "moved with Box 3" without an event of their own.
// Across locations the same event is written in the source location too (renderAudit() shows it
// without a diff to anyone who can't see the other end, D183). Links the move dropped are audited
// as `thing.unlink` where they lived; registry rows it created in the target account get their
// account-level `<entity>.create` rows (plan Q15), and each copied purchase a `purchase.create`
// in the target location (no amounts in it).
//
// Refusals: an invisible thing, target or target location, or a target the caller can't write,
// is a 404 (as the plan and the mock have it); a visible thing whose location the caller can't
// change is a 403; something going inside itself is a 409 (things_no_loop); a thing carrying
// secrets that only the source location's owner may move elsewhere is a 403 with a hint
// (things_move_secrets: the caller can see the thing, so a 404 would mislead); something carrying
// a code the target location already has is a 409 naming the code and its holder there
// (refuseCodeClash, D208).

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

export const MAX_MOVE = 200;
/** The most things, contents included, a move preview will count (security review #27). */
export const PREVIEW_MAX_THINGS = 1000;
/** Move previews per person per minute (security review #27). */
export const PREVIEWS_PER_MINUTE = 60;

const ThingIds = z.array(z.uuid()).min(1).max(MAX_MOVE);

export const MovePreviewBody = z.object({ thingIds: ThingIds, to: MoveTarget });
export type MovePreviewBody = z.infer<typeof MovePreviewBody>;

export const MoveBody = z.object({
  thingIds: ThingIds,
  to: MoveTarget,
  quantity: z.number().positive().max(999_999_999).multipleOf(0.001).optional(),
});
export type MoveBody = z.infer<typeof MoveBody>;

export const EmptyIntoBody = z.object({ to: MoveTarget });
export type EmptyIntoBody = z.infer<typeof EmptyIntoBody>;

export const MoveResultSchema = z.object({ moved: z.array(z.uuid()) });
export type MoveResult = z.infer<typeof MoveResultSchema>;

export const MovePreviewSchema = z.object({
  crossLocation: z.boolean(),
  crossAccount: z.boolean(),
  targetLocation: z.object({ id: z.uuid(), name: z.string() }),
  losesSight: z.array(z.object({ displayName: z.string() })),
  copies: z.object({
    types: z.number().int(),
    tags: z.number().int(),
    people: z.number().int(),
    vendors: z.number().int(),
    brands: z.number().int(),
    purchases: z.number().int(),
  }),
});
export type MovePreview = z.infer<typeof MovePreviewSchema>;

// ---------------------------------------------------------------------------------------------
// Where things go, and what moves
// ---------------------------------------------------------------------------------------------

type Target = {
  locationId: string;
  locationName: string;
  ownerAccountId: string;
  placeId: string | null;
  containerId: string | null;
};

/** The live place or thing `to` names, and its location: 404 when the caller can't see it. */
async function targetOf(client: pg.ClientBase, to: MoveTarget): Promise<Target> {
  const byPlace = 'placeId' in to;
  const id = (byPlace ? to.placeId : to.containerId).toLowerCase();
  const { rows } = await client.query<{ location_id: string; name: string; account: string }>(
    `SELECT x.location_id, l.name, l.owner_account_id AS account
       FROM public.${byPlace ? 'places' : 'things'} x
       JOIN public.locations l ON l.id = x.location_id
      WHERE x.id = $1 AND x.deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return {
    locationId: row.location_id,
    locationName: row.name,
    ownerAccountId: row.account,
    placeId: byPlace ? id : null,
    containerId: byPlace ? null : id,
  };
}

/** A target location the caller can't change is as absent as one they can't see (plan T15). */
async function requireWritableTarget(client: pg.ClientBase, target: Target): Promise<void> {
  const me = await callerMembership(client, target.locationId);
  if (!me || !can(me.role, 'things.edit')) throw notFound();
}

type Moving = {
  id: string;
  location_id: string;
  owner_account_id: string;
  place_id: string | null;
  container_id: string | null;
  path: string[];
};

const MOVING_COLUMNS = `t.id, t.location_id, l.owner_account_id, t.place_id, t.container_id,
  coalesce((SELECT array_agg(s->>'name' ORDER BY n)
              FROM jsonb_array_elements(kept.path_of(t.place_id, t.container_id))
                   WITH ORDINALITY AS x(s, n)), '{}') AS path`;

/** The live things `ids` names, in that order: 404 when any is missing or hidden. */
async function movingThings(client: pg.ClientBase, ids: readonly string[]): Promise<Moving[]> {
  const { rows } = await client.query<Moving>(
    `SELECT ${MOVING_COLUMNS}
       FROM public.things t JOIN public.locations l ON l.id = t.location_id
      WHERE t.id = ANY ($1::uuid[]) AND t.deleted_at IS NULL`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw notFound();
    return row;
  });
}

/** 403 unless the caller may change things in every location the things are in. */
async function requireWritableSources(client: pg.ClientBase, things: Moving[]): Promise<void> {
  for (const locationId of new Set(things.map((t) => t.location_id))) {
    await requireRole(client, locationId, 'things.edit');
  }
}

const LOOP = "Something can't go inside itself.";

/** 409 when the target container is one of `ids` or inside one of them. */
async function refuseLoop(client: pg.ClientBase, target: Target, ids: string[]): Promise<void> {
  if (!target.containerId) return;
  const { rowCount } = await client.query(
    `WITH RECURSIVE up(id, container_id) AS (
       SELECT id, container_id FROM public.things WHERE id = $1
       UNION
       SELECT t.id, t.container_id FROM public.things t JOIN up ON t.id = up.container_id)
     SELECT 1 FROM up WHERE id = ANY ($2::uuid[])`,
    [target.containerId, ids],
  );
  if (rowCount) throw new AppError('conflict', 409, LOOP);
}

/** Everything inside each of `ids` (trashed contents too: they travel along), by root. */
async function contentsOf(
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const { rows } = await client.query<{ root: string; id: string }>(
    `WITH RECURSIVE d(root, id) AS (
       SELECT t.container_id, t.id FROM public.things t WHERE t.container_id = ANY ($1::uuid[])
       UNION
       SELECT d.root, t.id FROM public.things t JOIN d ON t.container_id = d.id)
     SELECT root, id FROM d ORDER BY root, id`,
    [ids],
  );
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const r of rows) out.get(r.root)?.push(r.id);
  return out;
}

const isNoop = (t: Moving, target: Target) =>
  t.location_id === target.locationId &&
  t.place_id === target.placeId &&
  t.container_id === target.containerId;

// ---------------------------------------------------------------------------------------------
// Across owner accounts: what the definer creates on the other side
// ---------------------------------------------------------------------------------------------

type RegistryKind = 'type' | 'type_field' | 'brand' | 'vendor' | 'person' | 'tag';

const REGISTRY_TABLE: Record<RegistryKind, string> = {
  type: 'types',
  type_field: 'type_fields',
  brand: 'brands',
  vendor: 'vendors',
  person: 'people',
  tag: 'tags',
};

/** Ids of the target account's registry rows, per kind (the "before" of the diff). */
async function registryIds(
  client: pg.ClientBase,
  accountId: string,
): Promise<Map<RegistryKind, Set<string>>> {
  const kinds = Object.keys(REGISTRY_TABLE) as RegistryKind[];
  const { rows } = await client.query<{ kind: RegistryKind; id: string }>(
    kinds
      .map(
        (k) =>
          `SELECT '${k}'::text AS kind, id FROM public.${REGISTRY_TABLE[k]}
            WHERE owner_account_id = $1`,
      )
      .join(' UNION ALL '),
    [accountId],
  );
  const out = new Map<RegistryKind, Set<string>>(kinds.map((k) => [k, new Set()]));
  for (const r of rows) out.get(r.kind)?.add(r.id);
  return out;
}

type Created = { kind: RegistryKind; id: string; image: Record<string, unknown> };

/** The registry rows of the target account that weren't there `before`, with their images. */
async function createdRegistries(
  client: pg.ClientBase,
  accountId: string,
  before: Map<RegistryKind, Set<string>>,
): Promise<Created[]> {
  const after = await registryIds(client, accountId);
  const fresh = (k: RegistryKind) =>
    [...(after.get(k) ?? [])].filter((id) => !before.get(k)?.has(id));
  const out: Created[] = [];
  const types = fresh('type');
  const fields = fresh('type_field');
  if (types.length > 0) {
    const { rows } = await client.query<{
      id: string;
      name: string | null;
      parent_id: string | null;
      copied_from_id: string | null;
      is_field_group: boolean;
      fields: string[];
    }>(
      `SELECT t.id, t.name, t.parent_id, t.copied_from_id, t.is_field_group,
              coalesce((SELECT array_agg(f.key ORDER BY f.sort, f.key) FROM public.type_fields f
                         WHERE f.type_id = t.id), '{}') AS fields
         FROM public.types t WHERE t.id = ANY ($1::uuid[]) ORDER BY t.id`,
      [types],
    );
    for (const r of rows) {
      const { id, ...image } = r;
      out.push({ kind: 'type', id, image });
    }
  }
  if (fields.length > 0) {
    // Fields copied with a new type are in that type's image; only a field added to a type the
    // account already had (a secret field archived on arrival) is its own event.
    const { rows } = await client.query<{
      id: string;
      type_id: string;
      key: string;
      label: string | null;
      kind: string;
      secret: boolean;
      archived_at: Date | null;
    }>(
      `SELECT id, type_id, key, label, kind, secret, archived_at FROM public.type_fields
        WHERE id = ANY ($1::uuid[]) AND NOT (type_id = ANY ($2::uuid[])) ORDER BY id`,
      [fields, types],
    );
    for (const r of rows) {
      const { id, ...image } = r;
      out.push({ kind: 'type_field', id, image });
    }
  }
  for (const kind of ['brand', 'vendor', 'person', 'tag'] as const) {
    const ids = fresh(kind);
    if (ids.length === 0) continue;
    const column = kind === 'person' ? 'display_name' : 'name';
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, ${column} AS name FROM public.${REGISTRY_TABLE[kind]}
        WHERE id = ANY ($1::uuid[]) ORDER BY id`,
      [ids],
    );
    for (const r of rows) out.push({ kind, id: r.id, image: { [column]: r.name } });
  }
  return out;
}

/** Purchase lines of `ids`, to find the purchases a cross-account move copied. */
async function linesOf(
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; line: string }>(
    `SELECT id, purchase_line_id AS line FROM public.things
      WHERE id = ANY ($1::uuid[]) AND purchase_line_id IS NOT NULL`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.line]));
}

/** The purchases whose lines replaced `before`'s on the same things: the copies. */
async function copiedPurchases(
  client: pg.ClientBase,
  before: Map<string, string>,
): Promise<{ id: string; copiedFrom: string }[]> {
  if (before.size === 0) return [];
  const now = await linesOf(client, [...before.keys()]);
  const pairs = [...before].flatMap(([thing, line]) => {
    const next = now.get(thing);
    return next && next !== line ? [[line, next] as const] : [];
  });
  if (pairs.length === 0) return [];
  const { rows } = await client.query<{ id: string; copied_from: string }>(
    `SELECT DISTINCT n.purchase_id AS id, o.purchase_id AS copied_from
       FROM unnest($1::uuid[], $2::uuid[]) AS x(old_line, new_line)
       JOIN public.purchase_lines n ON n.id = x.new_line
       JOIN public.purchase_lines o ON o.id = x.old_line
      ORDER BY 1`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  return rows.map((r) => ({ id: r.id, copiedFrom: r.copied_from }));
}

// ---------------------------------------------------------------------------------------------
// The move
// ---------------------------------------------------------------------------------------------

type LinkRow = {
  id: string;
  location_id: string;
  from_thing_id: string;
  to_thing_id: string;
  kind: string;
};

const SECRETS_HINT =
  "Only the location's owner can move something with secret fields to another location.";

const CODE_TAKEN_THERE =
  'The other location already has one of the codes these things carry. Change or remove it on one of them, then move again.';

/**
 * 409 when something in `set` (the moved things and their contents) carries a code, own or
 * legacy, that the target location already has under any source (D208, §7.16: a location's codes
 * are unique whatever their source). Refused rather than dropped or renamed: a code is often a
 * printed label, and a move takes everything along (D161), so the person chooses which one
 * changes. The reply names the code and what holds it in the target location, which the caller
 * can write (requireWritableTarget), so nothing is shown that they couldn't open themselves.
 * Otherwise the definer's cascade of location_id onto legacy_codes hit the primary key: a 404.
 */
async function refuseCodeClash(
  client: pg.ClientBase,
  set: readonly string[],
  target: Target,
): Promise<void> {
  const { rows } = await client.query<{
    code: string;
    kind: 'thing' | 'place';
    id: string;
    name: string | null;
  }>(
    `SELECT m.code, CASE WHEN h.thing_id IS NULL THEN 'place' ELSE 'thing' END AS kind,
            coalesce(h.thing_id, h.place_id) AS id, coalesce(t.name, p.name) AS name
       FROM public.legacy_codes m
       JOIN public.legacy_codes h ON h.location_id = $2 AND h.code = m.code
       LEFT JOIN public.things t ON t.id = h.thing_id
       LEFT JOIN public.places p ON p.id = h.place_id
      WHERE m.thing_id = ANY ($1::uuid[]) AND m.location_id <> $2
      ORDER BY (m.source = 'own') DESC, m.code
      LIMIT 1`,
    [set, target.locationId],
  );
  const clash = rows[0];
  if (!clash) return;
  const on = clash.name ? `, on ${clash.name}` : '';
  throw new AppError(
    'conflict',
    409,
    `${target.locationName} already has the code ${clash.code}${on}. Change or remove it on one of them, then move again.`,
    {
      ownCode: clash.code,
      taken: { kind: clash.kind, id: clash.id, name: clash.name },
      location: { id: target.locationId, name: target.locationName },
    },
  );
}

/** kept.move_things(), with its refusal of secrets mapped to 403 (Phase-A security fix C1). */
async function callMoveThings(
  client: pg.ClientBase,
  ids: readonly string[],
  target: Target,
): Promise<{ thing_id: string; from_location: string; dropped_link_ids: string[] }[]> {
  try {
    const { rows } = await client.query<{
      thing_id: string;
      from_location: string;
      dropped_link_ids: string[];
    }>('SELECT * FROM kept.move_things($1::uuid[], $2, $3, $4)', [
      ids,
      target.locationId,
      target.placeId,
      target.containerId,
    ]);
    return rows;
  } catch (err) {
    const pg = pgErrorOf(err);
    if (pg?.code === '42501' && pg.constraint === 'things_move_secrets') {
      throw forbidden(SECRETS_HINT);
    }
    if (pg?.code === '23514' && pg.constraint === 'things_no_loop') {
      throw new AppError('conflict', 409, LOOP);
    }
    // refuseCodeClash() read the codes first; two things from two locations with one code, or a
    // code added there since, still reach the key.
    if (pg?.code === '23505' && pg.constraint === 'legacy_codes_pk') {
      throw new AppError('conflict', 409, CODE_TAKEN_THERE);
    }
    throw err;
  }
}

/**
 * The storage keys (originals and derivatives) of the files a move of `set` (the moved things
 * and their contents) copies: those attached to the things, their meter readings and their step-4
 * records (warranties, claims, loans, valuations, services), read under the caller's policies (the things' locations are theirs to see), and, across accounts, the
 * receipts of the things' purchases, which kept.copy_purchase_line() copies, reached through the
 * definers (the purchase may be where the caller can't see, D115): derivatives from
 * kept.thing_receipts(), the original from kept.thing_receipt_file(), which answers the mover
 * (a writer of the thing's location).
 */
async function blobKeysOf(
  client: pg.ClientBase,
  set: readonly string[],
  crossAccount: boolean,
): Promise<string[]> {
  const { rows } = await client.query<{ k: string }>(
    `WITH att AS (
       SELECT a.file_id FROM public.attachments a
        WHERE a.file_id IS NOT NULL
          AND (a.thing_id = ANY ($1::uuid[])
               OR a.meter_reading_id IN (SELECT d.id FROM public.meter_readings d
                                           JOIN public.meters m ON m.id = d.meter_id
                                          WHERE m.thing_id = ANY ($1::uuid[]))
               -- Step 4 (0051): the files of their warranties, claims, loans, valuations and
               -- services, which kept.move_things() re-homes as the things' own.
               OR a.warranty_id IN (SELECT w.id FROM public.warranties w
                                     WHERE w.thing_id = ANY ($1::uuid[]))
               OR a.claim_id IN (SELECT k.id FROM public.claims k
                                  WHERE k.thing_id = ANY ($1::uuid[]))
               OR a.loan_id IN (SELECT o.id FROM public.loans o
                                 WHERE o.thing_id = ANY ($1::uuid[]))
               OR a.valuation_id IN (SELECT v.id FROM public.valuations v
                                      WHERE v.thing_id = ANY ($1::uuid[]))
               OR a.service_record_id IN (SELECT r.id FROM public.service_records r
                                           WHERE r.thing_id = ANY ($1::uuid[]))))
     SELECT f.storage_key AS k FROM public.files f WHERE f.id IN (SELECT file_id FROM att)
     UNION
     SELECT d.storage_key FROM public.file_derivatives d WHERE d.file_id IN (SELECT file_id FROM att)`,
    [set],
  );
  const keys = rows.map((r) => r.k);
  if (!crossAccount) return keys;
  const { rows: receipts } = await client.query<{
    thumb_key: string | null;
    display_key: string | null;
    original: string | null;
  }>(
    `SELECT r.thumb_key, r.display_key,
            (SELECT o.storage_key FROM kept.thing_receipt_file(t.id, r.file_id) o) AS original
       FROM public.things t CROSS JOIN LATERAL kept.thing_receipts(t.id) r
      WHERE t.id = ANY ($1::uuid[]) AND t.purchase_line_id IS NOT NULL`,
    [set],
  );
  for (const r of receipts) {
    for (const k of [r.thumb_key, r.display_key, r.original]) if (k) keys.push(k);
  }
  return keys;
}

type Applied = {
  crossAccount: boolean;
  registries: Created[];
  purchases: { id: string; copiedFrom: string }[];
  droppedLinks: LinkRow[];
};

/**
 * Moves `things` (checked, locked, none of them a no-op) to `target`: same-location ones by UPDATE,
 * the rest through the definer. Returns what the move created or dropped, for the audit rows (or
 * the preview's counts).
 */
async function applyMove(
  client: pg.ClientBase,
  things: Moving[],
  target: Target,
): Promise<Applied> {
  const staying = things.filter((t) => t.location_id === target.locationId).map((t) => t.id);
  const leaving = things.filter((t) => t.location_id !== target.locationId);
  const out: Applied = { crossAccount: false, registries: [], purchases: [], droppedLinks: [] };

  if (staying.length > 0) {
    try {
      await client.query(
        `UPDATE public.things
            SET place_id = $2, container_id = $3, location_uncertain = false, last_seen_at = now()
          WHERE id = ANY ($1::uuid[])`,
        [staying, target.placeId, target.containerId],
      );
    } catch (err) {
      const pg = pgErrorOf(err);
      if (pg?.code === '23514' && pg.constraint === 'things_no_loop') {
        throw new AppError('conflict', 409, LOOP);
      }
      throw err;
    }
    // What is inside the moved things keeps its own place and container, so the UPDATE above
    // left its place_path (and the "where it is" of its search document) under the old place
    // until the reindex job ran. Setting search_tsv to NULL fires kept.thing_cache(), which
    // recomputes both from the rows as the UPDATE left them; only quiet columns change, so
    // row_version stays (0016, as kept.refresh_thing_doc() does it). kept_app has no grant on
    // place_path itself. Across locations kept.move_things() does the same (0047).
    const inside = [...(await contentsOf(client, staying)).values()].flat();
    if (inside.length > 0) {
      await client.query('UPDATE public.things SET search_tsv = NULL WHERE id = ANY ($1::uuid[])', [
        inside,
      ]);
    }
  }
  if (leaving.length === 0) return out;

  const ids = leaving.map((t) => t.id);
  const set = [...ids, ...[...(await contentsOf(client, ids)).values()].flat()];
  out.crossAccount = leaving.some((t) => t.owner_account_id !== target.ownerAccountId);
  const registriesBefore = out.crossAccount
    ? await registryIds(client, target.ownerAccountId)
    : null;
  const linesBefore = out.crossAccount ? await linesOf(client, set) : new Map<string, string>();
  const { rows: links } = await client.query<LinkRow>(
    `SELECT id, location_id, from_thing_id, to_thing_id, kind FROM public.thing_links
      WHERE from_thing_id = ANY ($1::uuid[]) OR to_thing_id = ANY ($1::uuid[])`,
    [set],
  );

  await refuseCodeClash(client, set, target);
  // The definer names the moved files' blobs from new rows (copies share them, D161): take their
  // blob locks first, so a delete of blobs no row names can't slip between (review #16, #18).
  await lockBlobKeys(client, await blobKeysOf(client, set, out.crossAccount));
  const rows = await callMoveThings(client, ids, target);

  const dropped = new Set(rows.flatMap((r) => r.dropped_link_ids ?? []));
  out.droppedLinks = links.filter((l) => dropped.has(l.id));
  if (registriesBefore) {
    out.registries = await createdRegistries(client, target.ownerAccountId, registriesBefore);
    out.purchases = await copiedPurchases(client, linesBefore);
  }
  return out;
}

/**
 * Moves `things` to `target` and audits it; shared by POST /things/move and
 * POST /things/:id/empty-into, which have already checked that the caller may change the things
 * and write the target. Locks the things, refuses loops, skips any already there.
 */
async function moveAndAudit(
  ctx: Ctx,
  things: Moving[],
  target: Target,
  undo?: UndoWriter,
  undoable = true,
): Promise<boolean> {
  const { client, scope } = ctx;
  const ids = things.map((t) => t.id);
  await client.query('SELECT 1 FROM public.things WHERE id = ANY ($1::uuid[]) FOR UPDATE', [ids]);
  await refuseLoop(client, target, ids);
  // Read again under the lock: the "before" of each audit row is where the thing is now.
  const moving = (await movingThings(client, ids)).filter((t) => !isNoop(t, target));
  if (moving.length === 0) return false;
  const movedIds = moving.map((t) => t.id);

  const applied = await applyMove(client, moving, target);

  const after = new Map((await movingThings(client, movedIds)).map((t) => [t.id, t]));
  const contents = await contentsOf(client, movedIds);
  const actor = actorOf(scope);
  // An undo's own rows aren't undoable again (audit/undo.ts), and carry no undo window; nor does
  // a move whose caller records one undoable event of its own (the inbox's bulk "set place").
  const until = undo || !undoable ? null : undoableUntil();
  const image = (t: Moving) => ({
    location_id: t.location_id,
    place_id: t.place_id,
    container_id: t.container_id,
    path: t.path,
  });
  const events: AuditEventInput[] = [];
  for (const before of moving) {
    const now = after.get(before.id) as Moving;
    const event = {
      actor,
      action: 'thing.move',
      entity: { type: 'thing', id: before.id },
      before: image(before),
      after: image(now),
      rootThingId: before.id,
      subjects: [before.id, ...(contents.get(before.id) ?? [])],
      requestId: ctx.requestId,
      undoableUntil: until,
    };
    events.push({ ...event, locationId: target.locationId });
    if (before.location_id !== target.locationId) {
      events.push({ ...event, locationId: before.location_id });
    }
  }
  for (const link of applied.droppedLinks) {
    events.push({
      locationId: link.location_id,
      actor,
      action: 'thing.unlink',
      entity: { type: 'thing_link', id: link.id },
      before: {
        from_thing_id: link.from_thing_id,
        to_thing_id: link.to_thing_id,
        kind: link.kind,
      },
      after: { dropped_by_move: true },
      rootThingId: link.from_thing_id,
      subjects: [link.from_thing_id, link.to_thing_id],
      requestId: ctx.requestId,
    });
  }
  for (const made of applied.registries) {
    events.push({
      locationId: null,
      ownerAccountId: target.ownerAccountId,
      actor,
      action: `${made.kind}.create`,
      entity: { type: made.kind, id: made.id },
      after: { ...made.image, copied_by_move: true },
      requestId: ctx.requestId,
    });
  }
  for (const purchase of applied.purchases) {
    events.push({
      locationId: target.locationId,
      actor,
      action: 'purchase.create',
      entity: { type: 'purchase', id: purchase.id },
      after: { copied_from_id: purchase.copiedFrom, copied_by_move: true },
      requestId: ctx.requestId,
    });
  }
  if (undo) {
    // The undo's row in the undone event's location goes through the undo registry (it sets
    // `undo_of`); every other row (the other end of a cross-location move, dropped links,
    // registry copies, purchases) is written as a forward move writes it.
    const at = events.findIndex(
      (e) => e.action === 'thing.move' && e.locationId === undo.locationId,
    );
    if (at < 0) throw new Error('undo of a move: no thing.move row for the undone location');
    const [primary] = events.splice(at, 1) as [AuditEventInput];
    await undo.write(primary);
  }
  // One INSERT per table for the lot: a bulk move of 200 things stays well under a second.
  await auditedMany(ctx.tx, events);

  // Breadcrumbs and search documents under a moved container, and everything that changed
  // location, are rebuilt by the reindex job (T20).
  const containerMoved = moving.some((t) => (contents.get(t.id) ?? []).length > 0);
  const crossed = moving.some((t) => t.location_id !== target.locationId);
  if (containerMoved || crossed) {
    const affected = new Set([target.locationId, ...moving.map((t) => t.location_id)]);
    for (const locationId of affected) await enqueueReindex(ctx.jobs, client, locationId);
  }
  return true;
}

/** How an undo writes its own audit row (things/undo.ts passes args.audit()). */
export type UndoWriter = {
  locationId: string;
  write: (event: AuditEventInput) => Promise<void>;
};

/**
 * Undo of a move (things/undo.ts): `thingId` goes back to `back` with everything a forward move
 * does (security review #21): the same checks (the target location must be writable, a 404;
 * the source a 403; loops a 409; secrets a 403 with its hint), the definer across locations,
 * and the same audit rows (both ends, dropped links, registry copies, purchases), the one in
 * the undone event's location written through `undo`. A place or container it came from that
 * is no longer live (trashed, deleted, converted) falls back to that location's Unplaced area.
 * 409 when that leaves nothing to move.
 */
export async function moveBackForUndo(
  ctx: Ctx,
  thingId: string,
  back: { locationId: string; placeId: string | null; containerId: string | null },
  undo: UndoWriter,
): Promise<void> {
  const { client } = ctx;
  let to: MoveTarget | null = null;
  if (back.containerId) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM public.things
        WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
      [back.containerId, back.locationId],
    );
    if (rowCount) to = { containerId: back.containerId };
  } else if (back.placeId) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM public.places
        WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
      [back.placeId, back.locationId],
    );
    if (rowCount) to = { placeId: back.placeId };
  }
  if (!to) {
    // The location itself may be gone from the caller's view: 404, as for any hidden target.
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
      [back.locationId],
    );
    if (!rows[0]) throw notFound();
    to = { placeId: rows[0].id };
  }
  const target = await targetOf(client, to);
  await requireWritableTarget(client, target);
  const things = await movingThings(client, [thingId]);
  await requireWritableSources(client, things);
  const moved = await moveAndAudit(ctx, things, target, undo);
  if (!moved) {
    throw new AppError('conflict', 409, "Can't undo: where it was is no longer there.");
  }
}

/** POST /api/v1/things/move → {moved}. `expected` is the If-Match the client may send for a
 * one-thing move (security review #25): a stale one is 412; with several things it is a 400.
 * `opts.undoable: false` writes the move's rows without an undo window, for a caller that records
 * one undoable event of its own (the inbox's bulk "set place", T15). */
export async function moveThings(
  ctx: Ctx,
  body: MoveBody,
  expected: number | null = null,
  opts: { undoable?: boolean } = {},
): Promise<MoveResult> {
  const { client } = ctx;
  let ids = [...new Set(body.thingIds.map((id) => id.toLowerCase()))];
  if (body.quantity !== undefined && ids.length !== 1) {
    throw invalid('Check body.quantity: it applies to one thing at a time.');
  }
  if (expected !== null && ids.length !== 1) {
    throw invalid('If-Match applies to a move of one thing; send none for several.');
  }
  const target = await targetOf(client, body.to);
  await requireWritableTarget(client, target);
  let things = await movingThings(client, ids);
  await requireWritableSources(client, things);
  if (expected !== null) {
    await writableThing(client, ids[0] as string, 'things.edit');
    await requireThingVersion(client, ids[0] as string, expected);
  }

  if (body.quantity !== undefined) {
    // Part of a quantity moves as a new thing split from it first (D10); all of it, as itself.
    const whole = await liveThing(client, ids[0] as string);
    if (body.quantity !== Number(whole.quantity)) {
      const { newId } = await splitThing(ctx, whole.id, { quantity: body.quantity }, null);
      ids = [newId];
      things = await movingThings(client, ids);
    }
  }
  await moveAndAudit(ctx, things, target, undefined, opts.undoable !== false);
  return { moved: ids };
}

/** POST /api/v1/things/:id/empty-into → {moved}: everything directly inside `id` ("Empty Box 3
 * into Box 5", D45), each moved as by POST /things/move (their own contents along). */
export async function emptyInto(ctx: Ctx, id: string, body: EmptyIntoBody): Promise<MoveResult> {
  const { client } = ctx;
  const box = await liveThing(client, id);
  await requireRole(client, box.location_id, 'things.edit');
  const target = await targetOf(client, body.to);
  await requireWritableTarget(client, target);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM public.things WHERE container_id = $1 AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [id],
  );
  const ids = rows.map((r) => r.id);
  // Into itself is a no-op: nothing moved (security review #28).
  if (ids.length === 0 || target.containerId === id) return { moved: [] };
  await moveAndAudit(ctx, await movingThings(client, ids), target);
  return { moved: ids };
}

// ---------------------------------------------------------------------------------------------
// The preview (read-only)
// ---------------------------------------------------------------------------------------------

/** Members of `sources` who aren't members of `target` (D45 "who will lose sight"). */
async function losingSight(
  client: pg.ClientBase,
  sources: readonly string[],
  target: string,
): Promise<{ displayName: string }[]> {
  if (sources.length === 0) return [];
  const { rows } = await client.query<{ display_name: string }>(
    `SELECT coalesce(max(up.display_name), 'A member') AS display_name
       FROM public.memberships m
       LEFT JOIN public.user_profiles up ON up.user_id = m.user_id
      WHERE m.location_id = ANY ($1::uuid[]) AND (m.expires_at IS NULL OR m.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM public.memberships n
                         WHERE n.location_id = $2 AND n.user_id = m.user_id
                           AND (n.expires_at IS NULL OR n.expires_at > now()))
      GROUP BY m.user_id
      ORDER BY 1, m.user_id`,
    [sources, target],
  );
  return rows.map((r) => ({ displayName: r.display_name }));
}

/**
 * POST /api/v1/things/move/preview → MovePreview. Read-only: what the move would copy is counted
 * by running it inside a savepoint that is always rolled back, so the counts are the definer's
 * own and can't drift from it. The preview refuses what the move would (404, 403 for secrets,
 * 409 for a loop), so the sheet can say so before the user confirms.
 */
export async function previewMove(ctx: Ctx, body: MovePreviewBody): Promise<MovePreview> {
  const { client } = ctx;
  const ids = [...new Set(body.thingIds.map((id) => id.toLowerCase()))];
  const target = await targetOf(client, body.to);
  await requireWritableTarget(client, target);
  const things = await movingThings(client, ids);
  await requireWritableSources(client, things);
  await refuseLoop(client, target, ids);
  // The preview runs the whole move in a savepoint: bounded, so a read can't cost more than a
  // move the web would offer (security review #27; the route also limits how often).
  const inside = [...(await contentsOf(client, ids)).values()].reduce((n, c) => n + c.length, 0);
  if (ids.length + inside > PREVIEW_MAX_THINGS) {
    throw invalid(
      `That would move more than ${PREVIEW_MAX_THINGS} things with what is inside them; move fewer at a time.`,
    );
  }

  const sources = [...new Set(things.map((t) => t.location_id))].filter(
    (l) => l !== target.locationId,
  );
  const preview: MovePreview = {
    crossLocation: sources.length > 0,
    crossAccount: things.some((t) => t.owner_account_id !== target.ownerAccountId),
    targetLocation: { id: target.locationId, name: target.locationName },
    losesSight: await losingSight(client, sources, target.locationId),
    copies: { types: 0, tags: 0, people: 0, vendors: 0, brands: 0, purchases: 0 },
  };
  if (!preview.crossLocation) return preview;

  await client.query('SAVEPOINT kept_move_preview');
  try {
    const applied = await applyMove(
      client,
      things.filter((t) => !isNoop(t, target)),
      target,
    );
    const count = (kind: RegistryKind) => applied.registries.filter((r) => r.kind === kind).length;
    preview.copies = {
      types: count('type'),
      tags: count('tag'),
      people: count('person'),
      vendors: count('vendor'),
      brands: count('brand'),
      purchases: applied.purchases.length,
    };
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT kept_move_preview');
    await client.query('RELEASE SAVEPOINT kept_move_preview');
  }
  return preview;
}
