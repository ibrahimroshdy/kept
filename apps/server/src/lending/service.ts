import { type LoanDirection, newId } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { createAttachment } from '../files/attachments.js';
import type { AttachmentView } from '../files/views.js';
import { assertClientId, checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { createItem } from '../registries/service.js';
import { requireModule } from '../schedules/service.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import {
  insertThing,
  liveThing,
  requireRole,
  splitThing,
  targetOf,
  writableThing,
} from '../things/service.js';
import type { ThingRow } from '../things/view.js';
import {
  anyRowsOf,
  LOAN_COLUMNS,
  LOAN_FROM,
  LOAN_VIEW_COLUMNS,
  type Loan,
  type LoanRecord,
  type LoanRow,
  loanImage,
  loanRowsOf,
  loansOf,
  loanView,
  OVERDUE_SQL,
} from './view.js';

// Lending and borrowing (plan T10; D10, D45, D56, D57, D119, D172; Q14–Q17, Q34). Every function
// runs in the request's scoped kept_app transaction: RLS decides what exists (a 404), the Lending
// module whether the location lends (404 on a read, 409 on a write, §7.6), and can() who may
// (`things.edit`: members and above; a viewer reads, a 403 on a write).
//
// - A loan is out (lent to someone) or in (borrowed from someone), one open loan per thing
//   (§7.13). The person is the account's registry, found, made by name, or the one linked to a
//   member (Q16: a member of that location gets the overdue reminder too, T14). Kept never
//   messages anyone outside the household (D57).
// - Lending part of a quantity splits the thing first (step 2's split, D10): the loan is on the
//   new row, `split_from_thing_id` the one it came from. A container goes with its contents
//   (D45): nothing moves, the path reads "with Murdock". Nothing in repair is lent (screens §8).
// - Borrowing makes a thing that belongs to the person (D56), with a loan in.
// - Return (return.ts): out, the thing goes back where it was (or where it is put), and a part
//   merges back into the row it came from when that row is live, in the same place and of the
//   same type (D172, Q14); in, the thing ends as `returned_to_owner` today (Q15).
// - Deletes are hard (Q25); the event holds the row and its photos, and undo puts them back.

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  files: FileStorage | null;
  jobs: JobQueue | null;
};

const MODULE = 'lending' as const;
export const actor = (scope: Scope) => actorOf(scope);

export type PersonInput = { id: string } | { name: string } | { memberUserId: string };

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

export async function loanRecord(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<LoanRecord> {
  const { rows } = await client.query<LoanRecord>(
    `SELECT ${LOAN_COLUMNS} FROM public.loans o WHERE o.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** A loan the caller may change, locked: 404, `module_off`, then 403 (before the lock, which a
 * refused UPDATE policy would turn into a 404). `closing`: returning an open loan, which stays
 * possible where Lending is off, so switching the module off never strands a thing on loan
 * (UI step-4 review L3); every other write is still `module_off`. */
export async function writableLoan(
  ctx: Ctx,
  id: string,
  { closing = false }: { closing?: boolean } = {},
): Promise<LoanRecord> {
  const seen = await loanRecord(ctx.client, id);
  if (!closing || seen.returned_at !== null) {
    await requireModule(ctx, seen.location_id, MODULE, 'write');
  }
  await requireRole(ctx.client, seen.location_id, 'things.edit');
  return loanRecord(ctx.client, id, true);
}

export async function requireLoanVersion(
  client: pg.ClientBase,
  row: LoanRecord,
  expected: number,
  fields: readonly string[],
): Promise<void> {
  if (row.row_version === expected) return;
  const by = await lastChangedBy(client, row.location_id, { type: 'loan', id: row.id });
  checkVersion({ rowVersion: row.row_version }, expected, fields, by ? { displayName: by } : null);
}

async function accountOf(client: pg.ClientBase, locationId: string): Promise<string> {
  const { rows } = await client.query<{ owner_account_id: string }>(
    'SELECT owner_account_id FROM public.locations WHERE id = $1',
    [locationId],
  );
  const id = rows[0]?.owner_account_id;
  if (!id) throw notFound();
  return id;
}

/**
 * The person a loan is with, in the location's account: an existing one (another account's, or
 * one the caller can't see, is a 404), a new one by name (D11, created inline), or the one linked
 * to a member of this location (made from their name if there is none yet, Q16).
 */
export async function personFor(ctx: Ctx, locationId: string, input: PersonInput): Promise<string> {
  const { client } = ctx;
  const accountId = await accountOf(client, locationId);
  if ('id' in input) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.people WHERE id = $1 AND owner_account_id = $2',
      [input.id, accountId],
    );
    if (!rowCount) throw notFound();
    return input.id.toLowerCase();
  }
  const writeCtx = {
    tx: ctx.tx,
    client,
    userId: ctx.scope.userId,
    requestId: ctx.requestId,
    jobs: ctx.jobs,
  };
  if ('memberUserId' in input) {
    const userId = input.memberUserId.toLowerCase();
    const { rows: linked } = await client.query<{ id: string }>(
      `SELECT id FROM public.people WHERE owner_account_id = $1 AND member_user_id = $2
        ORDER BY created_at, id LIMIT 1`,
      [accountId, userId],
    );
    if (linked[0]) return linked[0].id;
    const { rows: member } = await client.query<{ display_name: string | null }>(
      `SELECT up.display_name FROM public.memberships m
         JOIN public.user_profiles up ON up.user_id = m.user_id
        WHERE m.location_id = $1 AND m.user_id = $2`,
      [locationId, userId],
    );
    if (!member[0]) throw notFound();
    const made = await createItem(writeCtx, 'people', accountId, {
      displayName: member[0].display_name?.trim() || 'Member',
      userId,
    });
    return made.item.id;
  }
  const made = await createItem(writeCtx, 'people', accountId, { displayName: input.name.trim() });
  return made.item.id;
}

/** 409 `thing_in_repair` while a claim of the thing is in repair (screens §8: no Lend). */
async function refuseInRepair(client: pg.ClientBase, thingId: string): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM public.claims WHERE thing_id = $1 AND status = 'in_repair'`,
    [thingId],
  );
  if (rowCount) {
    throw new AppError('thing_in_repair', 409, "It's in repair; lend it once the claim is closed.");
  }
}

async function refuseOnLoan(client: pg.ClientBase, thingId: string): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.loans WHERE thing_id = $1 AND returned_at IS NULL',
    [thingId],
  );
  if (rowCount)
    throw new AppError('already_on_loan', 409, 'It is already on loan; mark it returned first.');
}

/** "Due ≥ start" (screens §7), in the location's zone. */
async function checkDue(
  client: pg.ClientBase,
  locationId: string,
  startedAt: Date,
  dueOn: string | null,
): Promise<void> {
  if (dueOn === null) return;
  const { rows } = await client.query<{ start: string }>(
    `SELECT ($2::timestamptz AT TIME ZONE l.timezone)::date::text AS start
       FROM public.locations l WHERE l.id = $1`,
    [locationId, startedAt],
  );
  if (rows[0] && dueOn < rows[0].start) {
    throw invalid('Check body.dueOn: a loan is due on or after the day it starts.');
  }
}

async function thingRow(ctx: Ctx, id: string): Promise<ThingRow> {
  const row = (await anyRowsOf(ctx.client, ctx.files, [id])).get(id);
  if (!row) throw notFound();
  return row;
}

async function auditLoan(
  ctx: Ctx,
  action: string,
  before: LoanRecord | null,
  after: LoanRecord | null,
  extra: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {},
  undoable = true,
): Promise<void> {
  const row = (after ?? before) as LoanRecord;
  await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actor(ctx.scope),
    action,
    entity: { type: 'loan', id: row.id },
    before: before ? { ...loanImage(before), ...extra.before } : null,
    after: after ? { ...loanImage(after), ...extra.after } : null,
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    ...(undoable ? { undoableUntil: undoableUntil() } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Lend and borrow
// ---------------------------------------------------------------------------------------------

export type LendInput = {
  loanId?: string | undefined;
  person: PersonInput;
  startedAt?: string | undefined;
  dueOn?: string | undefined;
  quantity?: string | undefined;
  notes?: string | undefined;
};

/** POST /api/v1/things/:id/lend → 201 {loan, thing, splitFrom?}. */
export async function lend(
  ctx: Ctx,
  thingId: string,
  body: LendInput,
): Promise<{ loan: Loan; thing: ThingRow; splitFrom?: ThingRow }> {
  const { client } = ctx;
  const seen = await liveThing(client, thingId);
  await requireModule(ctx, seen.location_id, MODULE, 'write');
  const thing = await writableThing(client, thingId, 'things.edit');
  const loanId = body.loanId ? assertClientId(body.loanId) : newId();
  await refuseOnLoan(client, thingId);
  await refuseInRepair(client, thingId);
  const { rows: life } = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM public.things WHERE id = $1',
    [thingId],
  );
  if (life[0]?.lifecycle !== 'in_use')
    throw conflict('It has ended; only something in use is lent.');
  const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
  if (startedAt.getTime() > Date.now() + 60_000)
    throw invalid('Check body.startedAt: not in the future.');
  await checkDue(client, thing.location_id, startedAt, body.dueOn ?? null);
  const personId = await personFor(ctx, thing.location_id, body.person);

  // Part of a quantity: split it off first (D10), and lend the part.
  const total = Number(thing.quantity);
  const quantity = body.quantity === undefined ? total : Number(body.quantity);
  if (!(quantity > 0) || quantity > total) {
    throw invalid(`Check body.quantity: more than 0 and at most the ${thing.quantity} there are.`);
  }
  let lentId = thingId;
  let splitFrom: string | null = null;
  if (quantity < total) {
    const split = await splitThing(ctx, thingId, { quantity }, null);
    lentId = split.newId;
    splitFrom = thingId;
  }
  const { rows: at } = await client.query<{ place_id: string | null; container_id: string | null }>(
    'SELECT place_id, container_id FROM public.things WHERE id = $1',
    [lentId],
  );
  await client.query(
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               previous_place_id, previous_container_id, split_from_thing_id,
                               notes, created_by)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, $9, $10, kept.current_user_id())`,
    [
      loanId,
      thing.location_id,
      lentId,
      personId,
      startedAt,
      body.dueOn ?? null,
      at[0]?.place_id ?? null,
      at[0]?.container_id ?? null,
      splitFrom,
      body.notes ?? null,
    ],
  );
  await auditLoan(ctx, 'loan.create', null, await loanRecord(client, loanId), {}, false);
  return {
    loan: await loanView(client, ctx.files, loanId),
    thing: await thingRow(ctx, lentId),
    ...(splitFrom ? { splitFrom: await thingRow(ctx, splitFrom) } : {}),
  };
}

export type BorrowInput = {
  thingId?: string | undefined;
  loanId?: string | undefined;
  name: string;
  typeId?: string | undefined;
  target: { placeId: string } | { containerId: string };
  person: PersonInput;
  dueOn?: string | undefined;
  notes?: string | undefined;
};

/** POST /api/v1/locations/:id/borrow → 201 {loan, thing}: a thing that belongs to the person
 * (D56), where it is put, with a loan in. */
export async function borrow(
  ctx: Ctx,
  locationId: string,
  body: BorrowInput,
): Promise<{ loan: Loan; thing: ThingRow }> {
  const { client } = ctx;
  await requireModule(ctx, locationId, MODULE, 'write');
  await requireRole(client, locationId, 'things.edit');
  const loanId = body.loanId ? assertClientId(body.loanId) : newId();
  const startedAt = new Date();
  await checkDue(client, locationId, startedAt, body.dueOn ?? null);
  const personId = await personFor(ctx, locationId, body.person);
  const where = await targetOf(client, locationId, body.target);
  const thingId = await insertThing(ctx, {
    ...(body.thingId ? { id: body.thingId } : {}),
    locationId,
    ...(where.placeId ? { placeId: where.placeId } : { containerId: where.containerId as string }),
    name: body.name,
    ...(body.typeId ? { typeId: body.typeId } : {}),
    belongsToPersonId: personId,
  });
  await client.query(
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               previous_place_id, previous_container_id, notes, created_by)
     VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $9, kept.current_user_id())`,
    [
      loanId,
      locationId,
      thingId,
      personId,
      startedAt,
      body.dueOn ?? null,
      where.placeId,
      where.containerId,
      body.notes ?? null,
    ],
  );
  await auditLoan(ctx, 'loan.create', null, await loanRecord(client, loanId), {}, false);
  return { loan: await loanView(client, ctx.files, loanId), thing: await thingRow(ctx, thingId) };
}

// ---------------------------------------------------------------------------------------------
// Update and delete
// ---------------------------------------------------------------------------------------------

export type UpdateLoanInput = {
  dueOn?: string | null | undefined;
  notes?: string | null | undefined;
  person?: PersonInput | undefined;
};

/** PATCH /api/v1/loans/:id (If-Match) → Loan. Audited `loan.update`, undoable. */
export async function updateLoan(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateLoanInput,
): Promise<Loan> {
  const { client } = ctx;
  const before = await writableLoan(ctx, id);
  const fields = (Object.keys(body) as (keyof UpdateLoanInput)[]).filter(
    (k) => body[k] !== undefined,
  );
  await requireLoanVersion(client, before, expected, fields);
  if (fields.length === 0) return loanView(client, ctx.files, id);
  if (body.dueOn !== undefined)
    await checkDue(client, before.location_id, before.started_at, body.dueOn);
  const personId = body.person
    ? await personFor(ctx, before.location_id, body.person)
    : before.person_id;
  await client.query(
    `UPDATE public.loans
        SET due_on = CASE WHEN $2 THEN $3::date ELSE due_on END,
            notes = CASE WHEN $4 THEN $5 ELSE notes END,
            person_id = $6
      WHERE id = $1`,
    [
      id,
      body.dueOn !== undefined,
      body.dueOn ?? null,
      body.notes !== undefined,
      body.notes ?? null,
      personId,
    ],
  );
  await auditLoan(ctx, 'loan.update', before, await loanRecord(client, id));
  return loanView(client, ctx.files, id);
}

type AttachmentImage = {
  id: string;
  file_id: string | null;
  url: string | null;
  role: string;
  sort: number;
};

/** DELETE /api/v1/loans/:id (If-Match) → 204: a loan recorded by mistake. Hard (Q25); undoable
 * (the row and its photos come back). */
export async function deleteLoan(ctx: Ctx, id: string, expected: number): Promise<void> {
  const { client } = ctx;
  const before = await writableLoan(ctx, id);
  await requireLoanVersion(client, before, expected, []);
  const { rows: photos } = await client.query<AttachmentImage>(
    'SELECT id, file_id, url, role, sort FROM public.attachments WHERE loan_id = $1 ORDER BY sort, id',
    [id],
  );
  await client.query('DELETE FROM public.loans WHERE id = $1', [id]);
  await auditLoan(ctx, 'loan.delete', before, null, {
    before: { created_by: before.created_by, attachments: photos },
  });
}

// ---------------------------------------------------------------------------------------------
// Condition photos
// ---------------------------------------------------------------------------------------------

/** POST /api/v1/loans/:id/attachments {fileId, role} → 201: a condition photo, going out or
 * coming back (the attachments' `loan` subject). */
export async function addConditionPhoto(
  ctx: Ctx,
  id: string,
  body: { id?: string | undefined; fileId: string; role: 'condition_out' | 'condition_in' },
): Promise<AttachmentView> {
  const loan = await loanRecord(ctx.client, id);
  await requireModule(ctx, loan.location_id, MODULE, 'write');
  return createAttachment(
    ctx.tx,
    ctx.client,
    ctx.files,
    (loc) => gateFor(ctx.tx, loc, ctx.scope),
    ctx.scope.userId,
    {
      id: body.id ? assertClientId(body.id) : newId(),
      locationId: loan.location_id,
      fileId: body.fileId,
      subject: { loanId: id },
      role: body.role,
    },
    ctx.requestId,
  );
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

export type LoanState = 'open' | 'overdue' | 'returned';

export type LoansQuery = {
  direction?: LoanDirection | undefined;
  state?: LoanState | undefined;
  locationId?: string | undefined;
  personId?: string | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

/** A loan whose thing is live, or a returned part that merged back into a live row (D172). */
const LISTED_SQL = `(t.deleted_at IS NULL
   OR (o.returned_at IS NOT NULL AND o.split_from_thing_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.things s
                    WHERE s.id = o.split_from_thing_id AND s.deleted_at IS NULL)))`;

function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const raw = decodeCursor<unknown>(cursor);
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  return raw;
}

/**
 * GET /api/v1/loans: the Lending screen, across every location the caller sees with Lending on
 * (screens §1): overdue first, then open, soonest due first, then returned, latest first.
 * `counts` are the open loans out and in, and the overdue ones, for the same locations and person.
 */
export async function listLoans(
  client: pg.ClientBase,
  files: FileStorage | null,
  query: LoansQuery,
): Promise<{
  items: LoanRow[];
  counts: { out: number; in: number; overdue: number };
  next_cursor: string | null;
}> {
  const offset = offsetOf(query.cursor);
  const q = query.q?.trim() ? query.q.trim() : null;
  const scope = `kept.module_on(o.location_id, 'lending') AND ${LISTED_SQL}
     AND ($1::uuid IS NULL OR o.location_id = $1)
     AND ($2::uuid IS NULL OR o.person_id = $2)`;
  const scoped = [query.locationId?.toLowerCase() ?? null, query.personId?.toLowerCase() ?? null];
  const { rows: counted } = await client.query<{ out: number; in: number; overdue: number }>(
    `SELECT count(*) FILTER (WHERE o.returned_at IS NULL AND o.direction = 'out')::int AS out,
            count(*) FILTER (WHERE o.returned_at IS NULL AND o.direction = 'in')::int AS "in",
            count(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue
       ${LOAN_FROM} WHERE ${scope}`,
    scoped,
  );
  const { rows } = await client.query(
    `SELECT ${LOAN_VIEW_COLUMNS} ${LOAN_FROM}
      WHERE ${scope}
        AND ($3::text IS NULL OR o.direction = $3)
        AND ($4::text IS NULL
             OR ($4 = 'open' AND o.returned_at IS NULL)
             OR ($4 = 'overdue' AND ${OVERDUE_SQL})
             OR ($4 = 'returned' AND o.returned_at IS NOT NULL))
        AND ($5::text IS NULL
             OR strpos(kept.normalize(coalesce(t.name, '')), kept.normalize($5)) > 0
             OR strpos(kept.normalize(coalesce(pe.display_name, '')), kept.normalize($5)) > 0)
      ORDER BY ${OVERDUE_SQL} DESC, (o.returned_at IS NOT NULL),
               CASE WHEN o.returned_at IS NULL THEN coalesce(o.due_on, DATE '9999-12-31') END,
               o.returned_at DESC NULLS FIRST, o.started_at DESC, o.id
      LIMIT $6 OFFSET $7`,
    [...scoped, query.direction ?? null, query.state ?? null, q, query.limit + 1, offset],
  );
  const page = rows.slice(0, query.limit);
  return {
    items: await loanRowsOf(client, files, page),
    counts: counted[0] ?? { out: 0, in: 0, overdue: 0 },
    next_cursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
  };
}

/**
 * GET /api/v1/things/:id/loans → the thing's loan history, newest first, with the loans of the
 * parts that were split off it, lent and merged back (D172). Where Lending is off, only its open
 * loan, so the thing page can still mark it returned (UI step-4 review L3); none is `module_off`.
 */
export async function thingLoans(
  ctx: Pick<Ctx, 'tx' | 'client' | 'scope' | 'files'>,
  thingId: string,
): Promise<{ items: Loan[] }> {
  const thing = await liveThing(ctx.client, thingId);
  const on = (await gateFor(ctx.tx, thing.location_id, ctx.scope)).modules.has(MODULE);
  const { rows } = await ctx.client.query(
    on
      ? `SELECT ${LOAN_VIEW_COLUMNS} ${LOAN_FROM}
          WHERE o.thing_id = $1
             OR (o.split_from_thing_id = $1 AND t.deleted_at IS NOT NULL
                 AND o.returned_at IS NOT NULL)
          ORDER BY o.started_at DESC, o.id DESC`
      : `SELECT ${LOAN_VIEW_COLUMNS} ${LOAN_FROM} WHERE o.thing_id = $1 AND o.returned_at IS NULL`,
    [thingId],
  );
  if (!on && rows.length === 0) throw new AppError('module_off', 404);
  return { items: await loansOf(ctx.client, ctx.files, rows) };
}

/**
 * GET /api/v1/people/:id/loans → the person page (D57): what they have of ours (open, out), what
 * they lent us (open, in), and the returned ones, 20 a page. A person the caller can't see (of
 * another account) is a 404; only locations with Lending on are read.
 */
export async function personLoans(
  ctx: Pick<Ctx, 'client' | 'files'>,
  personId: string,
  page: { limit: number; cursor?: string | undefined },
): Promise<{ has: LoanRow[]; lentUs: LoanRow[]; history: LoanRow[]; next_cursor: string | null }> {
  const { client, files } = ctx;
  const { rowCount } = await client.query('SELECT 1 FROM public.people WHERE id = $1', [personId]);
  if (!rowCount) throw notFound();
  const offset = offsetOf(page.cursor);
  const base = `${LOAN_FROM}
     WHERE o.person_id = $1 AND kept.module_on(o.location_id, 'lending') AND ${LISTED_SQL}`;
  const { rows: open } = await client.query<{ direction: LoanDirection }>(
    `SELECT ${LOAN_VIEW_COLUMNS} ${base} AND o.returned_at IS NULL
      ORDER BY ${OVERDUE_SQL} DESC, coalesce(o.due_on, DATE '9999-12-31'), o.started_at, o.id`,
    [personId],
  );
  const { rows: past } = await client.query(
    `SELECT ${LOAN_VIEW_COLUMNS} ${base} AND o.returned_at IS NOT NULL
      ORDER BY o.returned_at DESC, o.id DESC LIMIT $2 OFFSET $3`,
    [personId, page.limit + 1, offset],
  );
  return {
    has: await loanRowsOf(
      client,
      files,
      open.filter((o) => o.direction === 'out'),
    ),
    lentUs: await loanRowsOf(
      client,
      files,
      open.filter((o) => o.direction === 'in'),
    ),
    history: await loanRowsOf(client, files, past.slice(0, page.limit)),
    next_cursor: past.length > page.limit ? encodeCursor(offset + page.limit) : null,
  };
}
