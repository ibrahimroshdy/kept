import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireMembership } from '../locations/access.js';
import type { FileStorage } from '../storage/blob-store.js';
import { typeCapabilities } from '../things/fields.js';
import { liveThing, updateThing, writableThing } from '../things/service.js';
import { rowsOf, type ThingRow } from '../things/view.js';

// Consumables (step-7 plan T17; D14, D183; Q19). Every function runs in the request's scoped
// kept_app transaction: row-level security decides what exists (a 404), the route's module gate
// whether Consumables is on there (http/modules.ts: 404 `module_off` on a read, 409 on a write),
// and can() who may write (`things.edit`: members and above; a viewer reads, a 403 on a write).
//
// - "Keep at least N" is one `stock_rules` row per thing, only on a thing whose type is
//   consumable through its chain (409 `not_consumable`; the table's trigger says the same).
//   Setting, changing and removing it is audited `thing.stock_rule` on the thing, with the
//   minimum before and after (`min_quantity`), undoable for 7 days (./undo.ts).
// - Low is fewer than the minimum (`isLow`, Q19): with "keep at least 4", 4 left is fine. Only a
//   live thing in use counts: an ended one (used up and thrown away, sold) isn't in the house.
// - Adjust is a quantity edit through the thing's own update (things/service.ts updateThing), so
//   it is the same `thing.update` with the same undo, version check and quantity rules (D10):
//   a consumable may reach 0 (D183), never below.
//
// Low-stock reminders are the agenda's `stock` source (0104): due from the day a thing ran low
// (stock_rules.low_since, kept by triggers), sent by the reminder scan; the Consumables list and
// Home's attention row show the same low things.

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  files: FileStorage | null;
  jobs: JobQueue | null;
};

/** "Keep at least N" on one thing: apps/web/src/api/portability/types.ts StockRule. */
export type StockRule = {
  thingId: string;
  locationId: string;
  minQuantity: number;
  updatedAt: string;
  rowVersion: number;
};

export type ConsumableRow = { thing: ThingRow; minQuantity: number; low: boolean };

type RuleRecord = {
  id: string;
  thing_id: string;
  location_id: string;
  min_quantity: string;
  updated_at: Date;
  row_version: number;
};

const RULE_COLUMNS = `r.id, r.thing_id, r.location_id, trim_scale(r.min_quantity)::text AS min_quantity,
       r.updated_at, r.row_version`;

const ruleOf = (r: RuleRecord): StockRule => ({
  thingId: r.thing_id,
  locationId: r.location_id,
  minQuantity: Number(r.min_quantity),
  updatedAt: r.updated_at.toISOString(),
  rowVersion: r.row_version,
});

/** The thing's rule as the caller sees it, or null. */
export async function ruleRecord(
  client: pg.ClientBase,
  thingId: string,
  lock = false,
): Promise<RuleRecord | null> {
  const { rows } = await client.query<RuleRecord>(
    `SELECT ${RULE_COLUMNS} FROM public.stock_rules r WHERE r.thing_id = $1${
      lock ? ' FOR UPDATE' : ''
    }`,
    [thingId],
  );
  return rows[0] ?? null;
}

/** 412 unless the rule is at `expected` (D156), naming who changed the thing since. */
async function requireRuleVersion(
  client: pg.ClientBase,
  rule: RuleRecord,
  expected: number,
): Promise<void> {
  if (rule.row_version === expected) return;
  const by = await lastChangedBy(client, rule.location_id, { type: 'thing', id: rule.thing_id });
  checkVersion(
    { rowVersion: rule.row_version },
    expected,
    ['minQuantity'],
    by ? { displayName: by } : null,
  );
}

const notConsumable = () =>
  new AppError('not_consumable', 409, 'Only things you run out of can have a minimum.');

/** The audit row of a rule's change, on the thing (its timeline, and the Undo toast). */
async function auditRule(
  ctx: Pick<Ctx, 'tx' | 'scope' | 'requestId'>,
  thing: { id: string; location_id: string },
  before: number | null,
  after: number | null,
): Promise<void> {
  await audited(ctx.tx, {
    locationId: thing.location_id,
    actor: actorOf(ctx.scope),
    action: 'thing.stock_rule',
    entity: { type: 'thing', id: thing.id },
    before: { min_quantity: before },
    after: { min_quantity: after },
    rootThingId: thing.id,
    subjects: [thing.id],
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** GET /api/v1/things/:id/stock-rule: 404 when the thing has none. */
export async function getStockRule(ctx: Ctx, thingId: string): Promise<StockRule> {
  await liveThing(ctx.client, thingId);
  const rule = await ruleRecord(ctx.client, thingId);
  if (!rule) throw notFound('This thing keeps no minimum.');
  return ruleOf(rule);
}

export type ListQuery = {
  locationId: string;
  state?: 'low' | 'all' | undefined;
  placeId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
};

type ListKey = [low: boolean, name: string, id: string];

const ICU = 'COLLATE "und-x-icu"';
const LOW = 't.quantity < r.min_quantity';
const NAME = `lower(coalesce(t.name, '')) ${ICU}`;

/**
 * GET /api/v1/consumables: the location's things that keep a minimum, low first, then by name
 * (ICU collation), one keyset page at a time. `state=low` keeps the low ones only.
 */
export async function listConsumables(
  ctx: Ctx,
  q: ListQuery,
): Promise<{ items: ConsumableRow[]; next_cursor: string | null }> {
  const locationId = q.locationId.toLowerCase();
  await requireMembership(ctx.client, locationId);
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = [
    `r.location_id = ${p(locationId)}::uuid`,
    't.deleted_at IS NULL',
    `t.lifecycle = 'in_use'`,
  ];
  if (q.state === 'low') where.push(LOW);
  if (q.placeId) where.push(`t.place_id = ${p(q.placeId.toLowerCase())}::uuid`);
  if (q.cursor) {
    const key = decodeCursor<ListKey>(q.cursor);
    if (
      !Array.isArray(key) ||
      typeof key[0] !== 'boolean' ||
      typeof key[1] !== 'string' ||
      typeof key[2] !== 'string'
    ) {
      throw invalid('The cursor is not valid; start again from the first page.');
    }
    const [low, name, id] = key;
    const N = `${p(name)}::text ${ICU}`;
    const I = `${p(id)}::uuid`;
    // Low (true) sorts first: after a low row come later low rows, then every row that isn't.
    where.push(
      low
        ? `((${LOW}) AND (${NAME} > ${N} OR (${NAME} = ${N} AND t.id > ${I})) OR NOT (${LOW}))`
        : `(NOT (${LOW}) AND (${NAME} > ${N} OR (${NAME} = ${N} AND t.id > ${I})))`,
    );
  }
  const { rows } = await ctx.client.query<{
    id: string;
    low: boolean;
    name: string;
    min_quantity: string;
  }>(
    `SELECT t.id, (${LOW}) AS low, ${NAME} AS name, trim_scale(r.min_quantity)::text AS min_quantity
       FROM public.stock_rules r JOIN public.things t ON t.id = r.thing_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY (${LOW}) DESC, ${NAME}, t.id
      LIMIT ${p(q.limit + 1)}`,
    values,
  );
  const page = rows.slice(0, q.limit);
  const things = new Map(
    (
      await rowsOf(
        ctx.client,
        ctx.files,
        page.map((r) => r.id),
      )
    ).map((t) => [t.id, t]),
  );
  const items: ConsumableRow[] = [];
  for (const r of page) {
    const thing = things.get(r.id);
    if (thing) items.push({ thing, minQuantity: Number(r.min_quantity), low: r.low });
  }
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      rows.length > q.limit && last ? encodeCursor([last.low, last.name, last.id]) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** PUT /api/v1/things/:id/stock-rule: sets or changes the minimum. `expected` is required when
 * the rule exists (428 otherwise), ignored when it doesn't. */
export async function putStockRule(
  ctx: Ctx,
  thingId: string,
  expected: number | undefined,
  minQuantity: number,
): Promise<StockRule> {
  const { client } = ctx;
  const thing = await writableThing(client, thingId, 'things.edit');
  if (!(await typeCapabilities(client, thing.type_id)).includes('consumable')) {
    throw notConsumable();
  }
  const rule = await ruleRecord(client, thingId, true);
  if (rule) {
    if (expected === undefined) {
      throw new AppError(
        'precondition_failed',
        428,
        'Send If-Match with the row_version you started from.',
      );
    }
    await requireRuleVersion(client, rule, expected);
    const before = Number(rule.min_quantity);
    if (before === minQuantity) return ruleOf(rule);
    await client.query('UPDATE public.stock_rules SET min_quantity = $2 WHERE id = $1', [
      rule.id,
      minQuantity,
    ]);
    await auditRule(ctx, thing, before, minQuantity);
  } else {
    await client.query(
      `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
       VALUES ($1, $2, $3, kept.current_user_id())`,
      [thingId, thing.location_id, minQuantity],
    );
    await auditRule(ctx, thing, null, minQuantity);
  }
  const now = await ruleRecord(client, thingId);
  if (!now) throw notFound();
  return ruleOf(now);
}

/** DELETE /api/v1/things/:id/stock-rule (If-Match). 404 when there is none. */
export async function deleteStockRule(ctx: Ctx, thingId: string, expected: number): Promise<void> {
  const { client } = ctx;
  const thing = await writableThing(client, thingId, 'things.edit');
  const rule = await ruleRecord(client, thingId, true);
  if (!rule) throw notFound('This thing keeps no minimum.');
  await requireRuleVersion(client, rule, expected);
  await client.query('DELETE FROM public.stock_rules WHERE id = $1', [rule.id]);
  await auditRule(ctx, thing, Number(rule.min_quantity), null);
}

/** The largest quantity a thing holds (things/validate.ts Quantity). */
const QUANTITY_MAX = 999_999_999;

/** Thousandths, so 0.1 + 0.2 is 0.3 (quantities have 3 decimals). */
const milli = (n: number | string) => Math.round(Number(n) * 1000);

/**
 * POST /api/v1/things/:id/adjust (If-Match: the thing's row version): by `delta` or to
 * `quantity`, never below 0 (D183). The thing's own update writes it: `thing.update`, undoable.
 */
export async function adjustStock(
  ctx: Ctx,
  thingId: string,
  expected: number,
  body: { delta: number } | { quantity: number },
): Promise<ThingRow> {
  const seen = await liveThing(ctx.client, thingId);
  const target =
    'delta' in body ? (milli(seen.quantity) + milli(body.delta)) / 1000 : body.quantity;
  if (!Number.isFinite(target) || target < 0) {
    throw invalid("The quantity can't go below 0.");
  }
  if (target > QUANTITY_MAX) throw invalid(`The quantity is at most ${QUANTITY_MAX}.`);
  if (target !== Number(seen.quantity) || seen.row_version !== expected) {
    await updateThing(ctx, thingId, expected, { quantity: target });
  }
  const [row] = await rowsOf(ctx.client, ctx.files, [thingId]);
  if (!row) throw notFound();
  return row;
}

/** Things below their minimum where Consumables is on, among those the caller sees (Home). */
export async function lowStockCount(client: pg.ClientBase): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM public.stock_rules r JOIN public.things t ON t.id = r.thing_id
      WHERE t.deleted_at IS NULL AND t.lifecycle = 'in_use' AND ${LOW}
        AND kept.module_on(r.location_id, 'consumables')`,
  );
  return rows[0]?.n ?? 0;
}
