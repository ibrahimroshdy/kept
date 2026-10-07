import { type ClaimStatus, can, canTransitionClaim, newId, type Role } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Tx } from '../db/scope.js';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import {
  auditDeletedDocuments,
  type DocImage,
  documentsOf,
  documentsToDelete,
} from '../money/documents.js';
import { amountIn, currencyIn, moneyOff, requireEnabled, todayIn } from '../money/input.js';
import { auditRegistry } from '../registries/account.js';
import { type Gate, gateFor } from '../serialize/gates.js';
import { actor, type Ctx, liveThing, requireRole } from './service.js';
import {
  byCover,
  CLAIM_SELECT,
  type ClaimPrefill,
  type ClaimRow,
  type ClaimView,
  type CreateClaimBody,
  claimImage,
  claimView,
  type UpdateClaimBody,
  WARRANTY_SELECT,
  type WarrantyRow,
  warrantyState,
} from './view.js';

// Claims and repairs (step-4 plan T9; D54, D158, D195; Q18). Module `warranties`.
//
// - Read wherever the thing is seen; the cost and covered amount through the caller's gate.
// - Opened and changed with `schedules-claims.manage` (members and up). A service centre named by
//   a name the account doesn't have is created inline (D11, `people-vendors.create-inline`),
//   audited on the account as any vendor is.
// - `in_repair` puts the thing "at <vendor>" (things/view.ts repairAt, the derived state
//   in_repair), one claim at a time per thing: a second is 409 `thing_in_repair`.
// - Status moves by @kept/shared CLAIM_TRANSITIONS, else 409 `invalid_transition`; closing
//   (resolved, rejected) sets `closedOn`, today in the location's zone unless given. A closed
//   claim reopens only through undo (Q18).
// - Amounts are money: writing one (or the currency) where the gate hides money is 409
//   `module_off`, as for purchases; each needs a currency (claims_money_chk).
// - Audited on the thing's timeline: `claim.status` when the status changed, else `claim.update`;
//   both undoable, as is `claim.delete` (undo.ts).

const MANAGE_HINT = 'Viewers can’t open or change claims.';

export async function claimRow(client: pg.ClientBase, id: string, lock = false): Promise<ClaimRow> {
  const { rows } = await client.query<ClaimRow>(
    `${CLAIM_SELECT} WHERE c.id = $1${lock ? ' FOR UPDATE OF c' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function viewsOf(
  ctx: Pick<Ctx, 'client' | 'files'>,
  gate: Gate,
  rows: readonly ClaimRow[],
): Promise<ClaimView[]> {
  const docs = await documentsOf(
    ctx.client,
    ctx.files,
    'claim_id',
    rows.map((r) => r.id),
    gate.showMoney,
  );
  return rows.map((r) => claimView(r, gate, docs.get(r.id) ?? []));
}

async function oneView(ctx: Ctx, locationId: string, id: string): Promise<ClaimView> {
  const gate = await gateFor(ctx.tx, locationId, ctx.scope);
  const [view] = await viewsOf(ctx, gate, [await claimRow(ctx.client, id)]);
  return view as ClaimView;
}

// ---------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------

/** A vendor of the location's account by id (400 otherwise), or one by name: the account's own
 * of that name, else a new service centre, made inline and audited on the account. */
async function vendorFor(
  ctx: Ctx,
  role: Role,
  locationId: string,
  vendor: { id: string } | { name: string },
  where: string,
): Promise<string> {
  const { client } = ctx;
  const { rows: acct } = await client.query<{ id: string }>(
    'SELECT owner_account_id AS id FROM public.locations WHERE id = $1',
    [locationId],
  );
  const accountId = acct[0]?.id;
  if (!accountId) throw notFound();
  if ('id' in vendor) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.vendors WHERE id = $1 AND owner_account_id = $2',
      [vendor.id.toLowerCase(), accountId],
    );
    if (!rowCount) throw invalid(`Check ${where}.id: a vendor of this location’s account.`);
    return vendor.id.toLowerCase();
  }
  const { rows: found } = await client.query<{ id: string }>(
    `SELECT id FROM public.vendors
      WHERE owner_account_id = $1 AND kept.normalize(name) = kept.normalize($2)
      ORDER BY id LIMIT 1`,
    [accountId, vendor.name],
  );
  if (found[0]) return found[0].id;
  if (!can(role, 'people-vendors.create-inline')) {
    throw forbidden('Viewers can’t add a service centre.');
  }
  const id = newId();
  await client.query(
    `INSERT INTO public.vendors (id, owner_account_id, name, kind)
     VALUES ($1, $2, $3, 'service_centre')`,
    [id, accountId, vendor.name.trim()],
  );
  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.scope.userId,
    action: 'vendor.create',
    entity: { type: 'vendor', id },
    after: { name: vendor.name.trim(), kind: 'service_centre' },
    requestId: ctx.requestId,
  });
  return id;
}

async function checkWarranty(client: pg.ClientBase, warrantyId: string, thingId: string) {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.warranties WHERE id = $1 AND thing_id = $2',
    [warrantyId, thingId],
  );
  if (!rowCount) throw invalid("Check body.warrantyId: one of this thing's own warranties.");
}

async function checkIncident(client: pg.ClientBase, incidentId: string, locationId: string) {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.incidents WHERE id = $1 AND location_id = $2',
    [incidentId, locationId],
  );
  if (!rowCount) throw invalid('Check body.incidentId: an incident of this location.');
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/things/:id/claims, /claim-prefill
// ---------------------------------------------------------------------------------------------

export async function listClaims(
  ctx: Omit<Ctx, 'requestId'>,
  thingId: string,
): Promise<{ items: ClaimView[] }> {
  const thing = await liveThing(ctx.client, thingId);
  const gate = await gateFor(ctx.tx, thing.location_id, ctx.scope);
  const { rows } = await ctx.client.query<ClaimRow>(
    `${CLAIM_SELECT} WHERE c.thing_id = $1 ORDER BY c.opened_on DESC, c.created_at DESC, c.id DESC`,
    [thingId],
  );
  return { items: await viewsOf(ctx, gate, rows) };
}

/** The longest active warranty and the brand's contacts (screens §5: a claim prefills the
 * longest active warranty). */
export async function claimPrefill(client: pg.ClientBase, thingId: string): Promise<ClaimPrefill> {
  const thing = await liveThing(client, thingId);
  const today = await todayIn(client, thing.location_id);
  const { rows } = await client.query<WarrantyRow>(`${WARRANTY_SELECT} WHERE w.thing_id = $1`, [
    thingId,
  ]);
  const active = rows.filter((w) => warrantyState(w, today) !== 'ended').sort(byCover)[0];
  let claimUrl: string | null = null;
  let supportPhone: string | null = null;
  if (thing.brand_id) {
    const { rows: b } = await client.query<{
      claim_url: string | null;
      support_phone: string | null;
    }>('SELECT claim_url, support_phone FROM public.brands WHERE id = $1', [thing.brand_id]);
    claimUrl = b[0]?.claim_url ?? null;
    supportPhone = b[0]?.support_phone ?? null;
  }
  return {
    warrantyId: active?.id ?? null,
    claimUrl,
    supportPhone,
    claimContact: active?.claim_contact ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/things/:id/claims
// ---------------------------------------------------------------------------------------------

export async function createClaim(
  ctx: Ctx,
  thingId: string,
  body: CreateClaimBody,
): Promise<ClaimView> {
  const { client } = ctx;
  const thing = await liveThing(client, thingId);
  const role = await requireRole(client, thing.location_id, 'schedules-claims.manage', MANAGE_HINT);
  const id = body.id ? assertClientId(body.id) : newId();
  if (body.openedOn > (await todayIn(client, thing.location_id))) {
    throw invalid('Check body.openedOn: it is in the future where this location is.');
  }
  const warrantyId = body.warrantyId?.toLowerCase() ?? null;
  if (warrantyId) await checkWarranty(client, warrantyId, thingId);
  const incidentId = body.incidentId?.toLowerCase() ?? null;
  if (incidentId) await checkIncident(client, incidentId, thing.location_id);
  const vendorId = body.vendor
    ? await vendorFor(ctx, role, thing.location_id, body.vendor, 'body.vendor')
    : null;
  await client.query(
    `INSERT INTO public.claims (id, location_id, thing_id, warranty_id, incident_id, opened_on,
                                reference, vendor_id, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, kept.current_user_id())`,
    [
      id,
      thing.location_id,
      thingId,
      warrantyId,
      incidentId,
      body.openedOn,
      body.reference ?? null,
      vendorId,
      body.status ?? 'open',
      body.notes ?? null,
    ],
  );
  const row = await claimRow(client, id);
  await audited(ctx.tx, {
    locationId: thing.location_id,
    actor: actor(ctx.scope),
    action: 'claim.create',
    entity: { type: 'claim', id },
    after: claimImage(row),
    subjects: [thingId],
    rootThingId: thingId,
    requestId: ctx.requestId,
  });
  return oneView(ctx, thing.location_id, id);
}

// ---------------------------------------------------------------------------------------------
// PATCH /api/v1/claims/:id (If-Match)
// ---------------------------------------------------------------------------------------------

export const invalidTransition = (from: ClaimStatus, to: ClaimStatus) =>
  new AppError(
    'invalid_transition',
    409,
    from === 'resolved' || from === 'rejected'
      ? 'A closed claim reopens only through Undo.'
      : `An ${from === 'open' ? 'open' : 'in-repair'} claim can’t become ${to}.`,
  );

const isClosed = (s: ClaimStatus) => s === 'resolved' || s === 'rejected';

export async function updateClaim(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateClaimBody,
): Promise<ClaimView> {
  const { client } = ctx;
  const seen = await claimRow(client, id);
  await liveThing(client, seen.thing_id);
  const role = await requireRole(client, seen.location_id, 'schedules-claims.manage', MANAGE_HINT);
  const before = await claimRow(client, id, true);
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdateClaimBody] !== undefined);
  if (before.row_version !== expected) {
    const who = await lastChangedBy(client, before.location_id, { type: 'claim', id });
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      fields,
      who ? { displayName: who } : null,
    );
  }

  const status = body.status ?? before.status;
  if (status !== before.status && !canTransitionClaim(before.status, status)) {
    throw invalidTransition(before.status, status);
  }
  let closedOn = before.closed_on;
  if (isClosed(status)) {
    closedOn =
      body.closedOn ??
      (isClosed(before.status) ? before.closed_on : null) ??
      (await todayIn(client, before.location_id));
  } else {
    if (body.closedOn) throw invalid('Check body.closedOn: only a resolved or rejected claim.');
    closedOn = null;
  }
  if (closedOn !== null && closedOn < before.opened_on) {
    throw invalid('Check body.closedOn: on or after the day it was opened.');
  }

  // Money: any amount set or cleared, or the currency changed.
  const cost =
    body.cost === undefined
      ? undefined
      : body.cost === null
        ? null
        : amountIn(body.cost, 'body.cost');
  const covered =
    body.coveredAmount === undefined
      ? undefined
      : body.coveredAmount === null
        ? null
        : amountIn(body.coveredAmount, 'body.coveredAmount');
  const currency =
    body.currency === undefined ? before.currency : currencyIn(body.currency, 'body.currency');
  const gate = await gateFor(ctx.tx, before.location_id, ctx.scope);
  const writesMoney = cost !== undefined || covered !== undefined || currency !== before.currency;
  if (writesMoney && !gate.showMoney) throw moneyOff();
  if (currency && currency !== before.currency) {
    await requireEnabled(client, currency, 'body.currency');
  }
  const finalCost = cost === undefined ? before.cost : cost;
  const finalCovered = covered === undefined ? before.covered_amount : covered;
  if ((finalCost !== null || finalCovered !== null) && !currency) {
    throw invalid('Check body.currency: amounts need a currency. Pick one; none is assumed.');
  }

  const set: string[] = [];
  const values: unknown[] = [id];
  const put = (column: string, value: unknown) => {
    values.push(value);
    set.push(`${column} = $${values.length}`);
  };
  if (status !== before.status) put('status', status);
  if (closedOn !== before.closed_on) put('closed_on', closedOn);
  if (body.reference !== undefined) put('reference', body.reference);
  if (body.notes !== undefined) put('notes', body.notes);
  if (body.vendor !== undefined) {
    put(
      'vendor_id',
      body.vendor === null
        ? null
        : await vendorFor(ctx, role, before.location_id, body.vendor, 'body.vendor'),
    );
  }
  if (cost !== undefined) put('cost', cost);
  if (covered !== undefined) put('covered_amount', covered);
  if (currency !== before.currency) put('currency', currency);
  if (set.length > 0) {
    await client.query(`UPDATE public.claims SET ${set.join(', ')} WHERE id = $1`, values);
  }

  const after = await claimRow(client, id);
  const was = claimImage(before);
  const now = claimImage(after);
  if (JSON.stringify(was) !== JSON.stringify(now)) {
    await audited(ctx.tx, {
      locationId: before.location_id,
      actor: actor(ctx.scope),
      action: after.status !== before.status ? 'claim.status' : 'claim.update',
      entity: { type: 'claim', id },
      before: was,
      after: now,
      subjects: [before.thing_id],
      rootThingId: before.thing_id,
      requestId: ctx.requestId,
      undoableUntil: undoableUntil(),
    });
  }
  return oneView(ctx, before.location_id, id);
}

// ---------------------------------------------------------------------------------------------
// DELETE /api/v1/claims/:id (If-Match)
// ---------------------------------------------------------------------------------------------

export async function deleteClaim(ctx: Ctx, id: string, expected: number): Promise<void> {
  const { client } = ctx;
  const seen = await claimRow(client, id);
  await liveThing(client, seen.thing_id);
  const role = await requireRole(client, seen.location_id, 'schedules-claims.manage', MANAGE_HINT);
  const row = await claimRow(client, id, true);
  if (row.row_version !== expected) {
    const who = await lastChangedBy(client, row.location_id, { type: 'claim', id });
    checkVersion({ rowVersion: row.row_version }, expected, [], who ? { displayName: who } : null);
  }
  // Its amounts go with it: only someone who sees money deletes a claim that has some.
  if (
    (row.cost !== null || row.covered_amount !== null) &&
    !(await gateFor(ctx.tx, row.location_id, ctx.scope)).showMoney
  ) {
    throw moneyOff();
  }
  const docs: DocImage[] = await documentsToDelete(client, role, ctx.scope.userId, 'claim_id', id);
  await client.query('DELETE FROM public.claims WHERE id = $1', [id]);
  await auditDeletedDocuments(
    ctx.tx,
    {
      locationId: row.location_id,
      userId: ctx.scope.userId,
      column: 'claim_id',
      recordId: id,
      thingId: row.thing_id,
      requestId: ctx.requestId,
    },
    docs,
  );
  await audited(ctx.tx as Tx, {
    locationId: row.location_id,
    actor: actor(ctx.scope),
    action: 'claim.delete',
    entity: { type: 'claim', id },
    before: { ...claimImage(row), documents: docs },
    after: null,
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
}
