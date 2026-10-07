import { type Action, coverage, newId, type Role } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import {
  auditDeletedDocuments,
  type DocImage,
  documentsOf,
  documentsToDelete,
} from '../money/documents.js';
import { todayIn } from '../money/input.js';
import { type Gate, gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { purchaseDateOf, warrantyDefaults } from './defaults.js';
import {
  byCover,
  type CreateWarrantyBody,
  type UpdateWarrantyBody,
  WARRANTY_SELECT,
  type WarrantyDefaults,
  type WarrantyRow,
  type WarrantyView,
  warrantyImage,
  warrantyView,
} from './view.js';

// Warranties (step-4 plan T9; D53–D55, D195; Q26, Q27). Module `warranties` (the routes' config).
//
// - Several per thing, by kind, the longest cover first (lifetime, then the latest last day); a
//   term ends the day before its anniversary (`effective_ends_on`, L2). State: ended after its
//   last day, expiring from `lead_days` before it (in the location's zone), active otherwise.
// - The coverage bar (D195): bought (the purchase date, else the earliest start) → today →
//   covered until (the longest cover among those not ended; @kept/shared coverage()).
// - Written with `things.edit` (members and up). A thing with a warranty has quantity 1 (D10,
//   Q26): 409 `quantity_not_one`, "Split it first".
// - Audited on the thing's timeline; `warranty.update` and `warranty.delete` are undoable
//   (undo.ts). Deleting one leaves its claims without a warranty (the key is ON DELETE SET NULL);
//   the event names them, so undo links them again.

export type Ctx = {
  tx: Tx;
  client: pg.ClientBase;
  scope: Scope;
  requestId: string;
  files: FileStorage | null;
};

export type LiveThing = {
  id: string;
  location_id: string;
  quantity: string;
  brand_id: string | null;
  type_id: string | null;
};

/** The live thing the caller sees; 404 otherwise (or in the trash). */
export async function liveThing(client: pg.ClientBase, thingId: string): Promise<LiveThing> {
  const { rows } = await client.query<LiveThing>(
    `SELECT id, location_id, quantity::text AS quantity, brand_id, type_id
       FROM public.things WHERE id = $1 AND deleted_at IS NULL`,
    [thingId],
  );
  const t = rows[0];
  if (!t) throw notFound();
  return t;
}

/** 404 unless the caller sees the location; 403 unless their role may `action` there. */
export async function requireRole(
  client: pg.ClientBase,
  locationId: string,
  action: Action,
  hint: string,
): Promise<Role> {
  const me = await requireMembership(client, locationId);
  requireCan(me.role, action, hint);
  return me.role;
}

const EDIT_HINT = 'Viewers can’t change warranties.';

export const actor = (scope: Scope) => actorOf(scope);

export async function warrantyRow(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<WarrantyRow> {
  const { rows } = await client.query<WarrantyRow>(
    `${WARRANTY_SELECT} WHERE w.id = $1${lock ? ' FOR UPDATE OF w' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function viewsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  gate: Gate,
  rows: readonly WarrantyRow[],
  today: string,
): Promise<WarrantyView[]> {
  const docs = await documentsOf(
    client,
    files,
    'warranty_id',
    rows.map((r) => r.id),
    gate.showMoney,
  );
  return rows.map((r) => warrantyView(r, today, docs.get(r.id) ?? []));
}

async function oneView(ctx: Ctx, gate: Gate, id: string): Promise<WarrantyView> {
  const row = await warrantyRow(ctx.client, id);
  const today = await todayIn(ctx.client, row.location_id);
  const [view] = await viewsOf(ctx.client, ctx.files, gate, [row], today);
  return view as WarrantyView;
}

/** 400 unless a registration deadline and an end date sit after the start. */
function checkDates(w: {
  starts_on: string;
  ends_on: string | null;
  registration_deadline: string | null;
}): void {
  if (w.ends_on !== null && w.ends_on < w.starts_on) {
    throw invalid('Check body.endsOn: on or after the start.');
  }
  if (w.registration_deadline !== null && w.registration_deadline < w.starts_on) {
    throw invalid('Check body.registrationDeadline: on or after the start.');
  }
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/things/:id/warranties, /warranty-defaults
// ---------------------------------------------------------------------------------------------

export async function listWarranties(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  thingId: string,
): Promise<{
  items: WarrantyView[];
  coverage: { longestId: string | null; boughtOn: string | null; coveredUntil: string | null };
}> {
  const thing = await liveThing(client, thingId);
  const gate = await gateFor(tx, thing.location_id, scope);
  const { rows } = await client.query<WarrantyRow>(`${WARRANTY_SELECT} WHERE w.thing_id = $1`, [
    thingId,
  ]);
  const sorted = [...rows].sort(byCover);
  const today = await todayIn(client, thing.location_id);
  const cover = coverage(
    sorted.map((w) => ({
      id: w.id,
      startsOn: w.starts_on,
      endsOn: w.ends_on,
      termMonths: w.term_months,
      lifetime: w.lifetime,
    })),
    today,
  );
  const bought = await purchaseDateOf(client, thingId);
  return {
    items: await viewsOf(client, files, gate, sorted, today),
    coverage: {
      longestId: cover.longestId,
      boughtOn: bought ?? cover.boughtOn,
      coveredUntil: cover.coveredUntil,
    },
  };
}

export async function defaultsFor(
  client: pg.ClientBase,
  thingId: string,
): Promise<WarrantyDefaults> {
  const thing = await liveThing(client, thingId);
  return warrantyDefaults(client, thingId, thing);
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/things/:id/warranties
// ---------------------------------------------------------------------------------------------

export const splitFirst = () =>
  new AppError('quantity_not_one', 409, 'Split it first: a warranty covers one thing.');

export async function createWarranty(
  ctx: Ctx,
  thingId: string,
  body: CreateWarrantyBody,
): Promise<WarrantyView> {
  const { client } = ctx;
  const thing = await liveThing(client, thingId);
  await requireRole(client, thing.location_id, 'things.edit', EDIT_HINT);
  if (Number(thing.quantity) !== 1) throw splitFirst();
  const id = body.id ? assertClientId(body.id) : newId();
  checkDates({
    starts_on: body.startsOn,
    ends_on: body.endsOn ?? null,
    registration_deadline: body.registrationDeadline ?? null,
  });
  await client.query(
    `INSERT INTO public.warranties (id, location_id, thing_id, kind, provider, starts_on, ends_on,
                                    term_months, lifetime, lead_days, claim_contact, registered,
                                    registration_deadline, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, 30), $11, $12, $13,
             kept.current_user_id())`,
    [
      id,
      thing.location_id,
      thingId,
      body.kind,
      body.provider ?? null,
      body.startsOn,
      body.endsOn ?? null,
      body.termMonths ?? null,
      body.lifetime === true,
      body.leadDays ?? null,
      body.claimContact ?? null,
      body.registered ?? false,
      body.registrationDeadline ?? null,
    ],
  );
  const row = await warrantyRow(client, id);
  await audited(ctx.tx, {
    locationId: thing.location_id,
    actor: actor(ctx.scope),
    action: 'warranty.create',
    entity: { type: 'warranty', id },
    after: warrantyImage(row),
    subjects: [thingId],
    rootThingId: thingId,
    requestId: ctx.requestId,
  });
  return oneView(ctx, await gateFor(ctx.tx, thing.location_id, ctx.scope), id);
}

// ---------------------------------------------------------------------------------------------
// PATCH /api/v1/warranties/:id (If-Match)
// ---------------------------------------------------------------------------------------------

export async function updateWarranty(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateWarrantyBody,
): Promise<WarrantyView> {
  const { client } = ctx;
  const seen = await warrantyRow(client, id);
  await liveThing(client, seen.thing_id);
  await requireRole(client, seen.location_id, 'things.edit', EDIT_HINT);
  const before = await warrantyRow(client, id, true);
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdateWarrantyBody] !== undefined);
  if (before.row_version !== expected) {
    const who = await lastChangedBy(client, before.location_id, { type: 'warranty', id });
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      fields,
      who ? { displayName: who } : null,
    );
  }

  // The end: exactly one of a date, a term or lifetime. Setting one clears the others.
  let endsOn = before.ends_on;
  let termMonths = before.term_months;
  let lifetime = before.lifetime;
  if (body.endsOn) {
    endsOn = body.endsOn;
    termMonths = body.termMonths ?? null;
    lifetime = body.lifetime ?? false;
  } else if (body.termMonths) {
    termMonths = body.termMonths;
    endsOn = body.endsOn ?? null;
    lifetime = body.lifetime ?? false;
  } else if (body.lifetime === true) {
    lifetime = true;
    endsOn = null;
    termMonths = null;
  } else {
    if (body.endsOn === null) endsOn = null;
    if (body.termMonths === null) termMonths = null;
    if (body.lifetime === false) lifetime = false;
  }
  if ([endsOn !== null, termMonths !== null, lifetime].filter(Boolean).length !== 1) {
    throw invalid('Check body.endsOn: a warranty needs one of an end date, a term or lifetime.');
  }
  const next = {
    kind: body.kind ?? before.kind,
    provider: body.provider === undefined ? before.provider : body.provider,
    starts_on: body.startsOn ?? before.starts_on,
    ends_on: endsOn,
    term_months: termMonths,
    lifetime,
    lead_days: body.leadDays ?? before.lead_days,
    claim_contact: body.claimContact === undefined ? before.claim_contact : body.claimContact,
    registered: body.registered ?? before.registered,
    registration_deadline:
      body.registrationDeadline === undefined
        ? before.registration_deadline
        : body.registrationDeadline,
  };
  checkDates(next);
  const columns = Object.keys(next) as (keyof typeof next)[];
  await client.query(
    `UPDATE public.warranties SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')}
      WHERE id = $1`,
    [id, ...columns.map((c) => next[c])],
  );
  const after = await warrantyRow(client, id);
  const was = warrantyImage(before);
  const now = warrantyImage(after);
  if (JSON.stringify(was) !== JSON.stringify(now)) {
    await audited(ctx.tx, {
      locationId: before.location_id,
      actor: actor(ctx.scope),
      action: 'warranty.update',
      entity: { type: 'warranty', id },
      before: was,
      after: now,
      subjects: [before.thing_id],
      rootThingId: before.thing_id,
      requestId: ctx.requestId,
      undoableUntil: undoableUntil(),
    });
  }
  return oneView(ctx, await gateFor(ctx.tx, before.location_id, ctx.scope), id);
}

// ---------------------------------------------------------------------------------------------
// DELETE /api/v1/warranties/:id (If-Match)
// ---------------------------------------------------------------------------------------------

export async function deleteWarranty(ctx: Ctx, id: string, expected: number): Promise<void> {
  const { client } = ctx;
  const seen = await warrantyRow(client, id);
  await liveThing(client, seen.thing_id);
  const role = await requireRole(client, seen.location_id, 'things.edit', EDIT_HINT);
  const row = await warrantyRow(client, id, true);
  if (row.row_version !== expected) {
    const who = await lastChangedBy(client, row.location_id, { type: 'warranty', id });
    checkVersion({ rowVersion: row.row_version }, expected, [], who ? { displayName: who } : null);
  }
  const docs: DocImage[] = await documentsToDelete(
    client,
    role,
    ctx.scope.userId,
    'warranty_id',
    id,
  );
  const { rows: claims } = await client.query<{ id: string }>(
    'SELECT id FROM public.claims WHERE warranty_id = $1 ORDER BY id',
    [id],
  );
  await client.query('DELETE FROM public.warranties WHERE id = $1', [id]);
  await auditDeletedDocuments(
    ctx.tx,
    {
      locationId: row.location_id,
      userId: ctx.scope.userId,
      column: 'warranty_id',
      recordId: id,
      thingId: row.thing_id,
      requestId: ctx.requestId,
    },
    docs,
  );
  await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actor(ctx.scope),
    action: 'warranty.delete',
    entity: { type: 'warranty', id },
    before: { ...warrantyImage(row), documents: docs, claim_ids: claims.map((c) => c.id) },
    after: null,
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
}
