import { canonicalAmount, newId, type ValuationSource } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { type Gate, gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import {
  auditDeletedDocuments,
  type DocImage,
  documentsOf,
  documentsToDelete,
} from './documents.js';
import { amountIn, currencyIn, moneyOff, requireEnabled, todayIn } from './input.js';
import type {
  CreateValuationBody,
  CurrentValue,
  UpdateValuationBody,
  ValuationView,
} from './view.js';

// Valuations (step-4 plan T8; D158, D110): dated values of a thing, the newest its current value
// (the latest `valued_on`, then the latest made). Module `money` (the routes' config): with Money
// off in the thing's location every route is 404 (a read) or 409 (a write) `module_off`.
//
// - Read wherever the thing is seen; the value is `{moneyHidden: true}` where the caller's gate
//   hides money (a viewer, unless the location lets viewers see money: D13), and then the
//   documents are left out too (an appraisal shows the value).
// - Written with `things.edit` (members and up; a viewer 403) by someone who sees money there
//   (else 409 `module_off`, as for purchases). `valued_on` is never in the future where the
//   location is.
// - Audited on the thing's timeline (`rootThingId`), the value classed money (audit/classes.ts),
//   so renderAudit() hides it from viewers. `valuation.update` and `valuation.delete` are
//   undoable (undo.ts); a delete keeps the full row and its documents in the event (Q25).

export type ValCtx = {
  tx: Tx;
  client: pg.ClientBase;
  scope: Scope;
  requestId: string;
  files: FileStorage | null;
};

export type ValuationRow = {
  id: string;
  location_id: string;
  thing_id: string;
  value: string;
  currency: string;
  valued_on: string;
  source: ValuationSource;
  notes: string | null;
  row_version: number;
  created_by: string;
  display_name: string | null;
};

const SELECT = `SELECT v.id, v.location_id, v.thing_id, v.value::text AS value,
       v.currency::text AS currency, v.valued_on::text AS valued_on, v.source, v.notes,
       v.row_version, v.created_by, up.display_name
  FROM public.valuations v
  LEFT JOIN public.user_profiles up ON up.user_id = v.created_by`;
/** Newest first: the latest `valued_on`, then the latest made (uuidv7 ids sort by creation). */
const ORDER = 'ORDER BY v.valued_on DESC, v.created_at DESC, v.id DESC';

/** The audit image of a valuation (snake_case, as audited() stores it). */
export function valuationImage(r: ValuationRow): Record<string, unknown> {
  return {
    thing_id: r.thing_id,
    value: canonicalAmount(r.value),
    currency: r.currency,
    valued_on: r.valued_on,
    source: r.source,
    notes: r.notes,
  };
}

export async function valuationRow(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<ValuationRow> {
  const { rows } = await client.query<ValuationRow>(
    `${SELECT} WHERE v.id = $1${lock ? ' FOR UPDATE OF v' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function views(
  client: pg.ClientBase,
  files: FileStorage | null,
  gate: Gate,
  rows: readonly ValuationRow[],
): Promise<ValuationView[]> {
  const docs = gate.showMoney
    ? await documentsOf(
        client,
        files,
        'valuation_id',
        rows.map((r) => r.id),
        true,
      )
    : new Map();
  return rows.map((r) => ({
    id: r.id,
    value: gate.showMoney
      ? { amount: canonicalAmount(r.value) as string, currency: r.currency }
      : { moneyHidden: true as const },
    valuedOn: r.valued_on,
    source: r.source,
    notes: r.notes,
    documents: docs.get(r.id) ?? [],
    rowVersion: r.row_version,
    createdBy: { displayName: r.display_name ?? '' },
  }));
}

/** The live thing's location; 404 when the caller can't see it or it is in the trash. */
async function liveThingLocation(client: pg.ClientBase, thingId: string): Promise<string> {
  const { rows } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
    [thingId],
  );
  const loc = rows[0]?.location_id;
  if (!loc) throw notFound();
  return loc;
}

const EDIT_HINT = 'Viewers can’t change valuations.';

/** 404 unless visible; 403 unless the caller changes things there; 409 unless they see money. */
async function writeGate(ctx: ValCtx, locationId: string): Promise<Gate> {
  const me = await requireMembership(ctx.client, locationId);
  requireCan(me.role, 'things.edit', EDIT_HINT);
  const gate = await gateFor(ctx.tx, locationId, ctx.scope);
  if (!gate.showMoney) throw moneyOff();
  return gate;
}

async function checkValuedOn(client: pg.ClientBase, locationId: string, on: string) {
  if (on > (await todayIn(client, locationId))) {
    throw invalid('Check body.valuedOn: it is in the future where this location is.');
  }
}

const actor = (scope: Scope) => actorOf(scope);

// ---------------------------------------------------------------------------------------------
// GET /api/v1/things/:id/valuations
// ---------------------------------------------------------------------------------------------

export async function listValuations(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  thingId: string,
): Promise<{ items: ValuationView[]; current: ValuationView | null }> {
  const locationId = await liveThingLocation(client, thingId);
  const gate = await gateFor(tx, locationId, scope);
  const { rows } = await client.query<ValuationRow>(`${SELECT} WHERE v.thing_id = $1 ${ORDER}`, [
    thingId,
  ]);
  const items = await views(client, files, gate, rows);
  return { items, current: items[0] ?? null };
}

/**
 * The thing view's `currentValue` (D158): the newest valuation, `{moneyHidden: true}` where the
 * gate hides money (with or without one, so its absence tells a viewer nothing), null when there
 * is none. Undefined with the Money module off there: the field is left out.
 */
export async function currentValueOf(
  client: pg.ClientBase,
  gate: Gate,
  thingId: string,
): Promise<CurrentValue | null | undefined> {
  if (!gate.modules.has('money')) return undefined;
  if (!gate.showMoney) return { moneyHidden: true };
  const { rows } = await client.query<ValuationRow>(
    `${SELECT} WHERE v.thing_id = $1 ${ORDER} LIMIT 1`,
    [thingId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    amount: canonicalAmount(r.value) as string,
    currency: r.currency,
    valuedOn: r.valued_on,
    source: r.source,
  };
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/things/:id/valuations
// ---------------------------------------------------------------------------------------------

export async function createValuation(
  ctx: ValCtx,
  thingId: string,
  body: CreateValuationBody,
): Promise<ValuationView> {
  const { client } = ctx;
  const locationId = await liveThingLocation(client, thingId);
  const gate = await writeGate(ctx, locationId);
  const id = body.id ? assertClientId(body.id) : newId();
  const value = amountIn(body.value, 'body.value');
  const currency = currencyIn(body.currency, 'body.currency');
  await requireEnabled(client, currency, 'body.currency');
  await checkValuedOn(client, locationId, body.valuedOn);

  await client.query(
    `INSERT INTO public.valuations (id, location_id, thing_id, value, currency, valued_on, source,
                                    notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, kept.current_user_id())`,
    [id, locationId, thingId, value, currency, body.valuedOn, body.source, body.notes ?? null],
  );
  const row = await valuationRow(client, id);
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx.scope),
    action: 'valuation.create',
    entity: { type: 'valuation', id },
    after: valuationImage(row),
    subjects: [thingId],
    rootThingId: thingId,
    requestId: ctx.requestId,
  });
  const [view] = await views(client, ctx.files, gate, [row]);
  return view as ValuationView;
}

// ---------------------------------------------------------------------------------------------
// PATCH /api/v1/valuations/:id (If-Match)
// ---------------------------------------------------------------------------------------------

export async function updateValuation(
  ctx: ValCtx,
  id: string,
  expected: number,
  body: UpdateValuationBody,
): Promise<ValuationView> {
  const { client } = ctx;
  const seen = await valuationRow(client, id);
  await liveThingLocation(client, seen.thing_id);
  const gate = await writeGate(ctx, seen.location_id);
  const before = await valuationRow(client, id, true);
  const fields = Object.keys(body).filter(
    (k) => body[k as keyof UpdateValuationBody] !== undefined,
  );
  if (before.row_version !== expected) {
    const who = await lastChangedBy(client, before.location_id, { type: 'valuation', id });
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      fields,
      who ? { displayName: who } : null,
    );
  }
  const set: string[] = [];
  const values: unknown[] = [id];
  const put = (column: string, value: unknown) => {
    values.push(value);
    set.push(`${column} = $${values.length}`);
  };
  if (body.value !== undefined) put('value', amountIn(body.value, 'body.value'));
  if (body.currency !== undefined) {
    const currency = currencyIn(body.currency, 'body.currency');
    if (currency !== before.currency) await requireEnabled(client, currency, 'body.currency');
    put('currency', currency);
  }
  if (body.valuedOn !== undefined) {
    await checkValuedOn(client, before.location_id, body.valuedOn);
    put('valued_on', body.valuedOn);
  }
  if (body.source !== undefined) put('source', body.source);
  if (body.notes !== undefined) put('notes', body.notes);
  await client.query(`UPDATE public.valuations SET ${set.join(', ')} WHERE id = $1`, values);

  const after = await valuationRow(client, id);
  const was = valuationImage(before);
  const now = valuationImage(after);
  if (JSON.stringify(was) !== JSON.stringify(now)) {
    await audited(ctx.tx, {
      locationId: before.location_id,
      actor: actor(ctx.scope),
      action: 'valuation.update',
      entity: { type: 'valuation', id },
      before: was,
      after: now,
      subjects: [before.thing_id],
      rootThingId: before.thing_id,
      requestId: ctx.requestId,
      undoableUntil: undoableUntil(),
    });
  }
  const [view] = await views(client, ctx.files, gate, [after]);
  return view as ValuationView;
}

// ---------------------------------------------------------------------------------------------
// DELETE /api/v1/valuations/:id (If-Match)
// ---------------------------------------------------------------------------------------------

export async function deleteValuation(ctx: ValCtx, id: string, expected: number): Promise<void> {
  const { client } = ctx;
  const seen = await valuationRow(client, id);
  await liveThingLocation(client, seen.thing_id);
  await writeGate(ctx, seen.location_id);
  const me = await requireMembership(client, seen.location_id);
  const row = await valuationRow(client, id, true);
  if (row.row_version !== expected) {
    const who = await lastChangedBy(client, row.location_id, { type: 'valuation', id });
    checkVersion({ rowVersion: row.row_version }, expected, [], who ? { displayName: who } : null);
  }
  const docs: DocImage[] = await documentsToDelete(
    client,
    me.role,
    ctx.scope.userId,
    'valuation_id',
    id,
  );
  await client.query('DELETE FROM public.valuations WHERE id = $1', [id]);
  await auditDeletedDocuments(
    ctx.tx,
    {
      locationId: row.location_id,
      userId: ctx.scope.userId,
      column: 'valuation_id',
      recordId: id,
      thingId: row.thing_id,
      requestId: ctx.requestId,
    },
    docs,
  );
  await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actor(ctx.scope),
    action: 'valuation.delete',
    entity: { type: 'valuation', id },
    before: { ...valuationImage(row), documents: docs },
    after: null,
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
}
