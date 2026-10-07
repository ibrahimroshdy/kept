import { isDateFilterValue, newId, type ServiceLineKind } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import type { FieldClass } from '../audit/classes.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import { createAttachment } from '../files/attachments.js';
import { assertClientId, checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import { createReading, updateReading } from '../meters/service.js';
import { whenDays } from '../meters/when.js';
import { createItem } from '../registries/service.js';
import { gateFor } from '../serialize/gates.js';
import { requireRole } from '../things/service.js';
import { moneyOff, requireCurrencies } from '../things/validate.js';
import {
  type Ctx,
  requireModule,
  type SubjectInput,
  scheduleRow,
  subjectOfInput,
  todayIn,
  writableSchedule,
} from './service.js';
import {
  type Schedule,
  SERVICE_COLUMNS,
  SERVICE_FROM,
  SERVICE_VIEW_COLUMNS,
  type ServiceRecord,
  type ServiceRow,
  scheduleView,
  serviceRecordsOf,
} from './view.js';

// Service records (plan T11, Q1; D26, D29, D112, D113, D162): work done on a thing or a place,
// with its reading, vendor, total and lines, and the schedules it completes. Core: any member
// logs one (`logs.add`), changes their own (`logs.edit-own`) and an admin anyone's
// (`logs.edit-delete-others`, product design §7.1); only `completes` needs Schedules on.
//
// - The reading goes through the meters' own entry (meters/service.ts createReading), taken at
//   noon of the service day in the location's zone (§7.13) unless the request says when, so a
//   reading that runs backwards is refused at entry exactly as the meters section refuses it:
//   409 `conflict` with `reason` (`lower_than_previous` | `higher_than_next`) and the neighbour
//   it collides with (`previous` | `next`: {value, takenAt}) (D112, screens §5).
// - A completion re-anchors its schedules (0053's triggers); removing or re-dating the service
//   puts the anchor back (D162).
// - Money (the total, a line's cost) is written only by someone whose gate shows money: 409
//   `module_off` otherwise. Priced lines without a total make one (their sum).
// - Completing is undoable (the record and its new reading go; the schedules' snooze and skip
//   come back); so are an edit and a delete (the row, its lines, completions and files return).
// - Step 5 (T9, Q12): a draft (an invoice being read by AI, services/drafts.ts) counts nowhere and
//   is finished by confirmService(), which applies the create rules above to the draft's own row:
//   the reading, the lines, the money, the vendor and `completes`. A draft isn't edited (409
//   `service_draft`); its logger, or an admin, deletes it, with its read, at any time.

const actor = (ctx: Ctx) => actorOf(ctx.scope);
const MAX_LINES = 50;
/** Money in a service's audit image (D110): the total, and the lines (their costs). */
const CLASSES: Record<string, FieldClass> = { total: 'money', lines: 'money' };

export type LineInput = {
  kind: ServiceLineKind;
  description: string;
  quantity?: string | undefined;
  unitCost?: string | undefined;
};
export type VendorInput = { id: string } | { name: string };

export type CreateServiceInput = {
  id?: string | undefined;
  subject: SubjectInput;
  servicedOn: string;
  reading?:
    | {
        meterId: string;
        value: string;
        proofFileId?: string | undefined;
        takenAt?: string | undefined;
      }
    | undefined;
  vendor?: VendorInput | undefined;
  total?: string | undefined;
  currency?: string | undefined;
  lines?: LineInput[] | undefined;
  completes?: string[] | undefined;
  notes?: string | undefined;
};

// ---------------------------------------------------------------------------------------------
// Rows and images
// ---------------------------------------------------------------------------------------------

type LineImage = {
  id: string;
  kind: ServiceLineKind;
  description: string;
  quantity: string | null;
  unit_cost: string | null;
  sort: number;
};

export type ServiceImage = {
  thing_id: string | null;
  place_id: string | null;
  serviced_on: string;
  meter_reading_id: string | null;
  /** The reading's value (an edit may change it in place). */
  reading_value: string | null;
  vendor_id: string | null;
  total: string | null;
  currency: string | null;
  notes: string | null;
  lines: LineImage[];
  completes: string[];
};

export async function serviceRow(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<ServiceRow> {
  const { rows } = await client.query<ServiceRow>(
    `SELECT ${SERVICE_COLUMNS} FROM public.service_records r WHERE r.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** A service's audit image: its row, its lines and the schedules it completes. The three reads
 * run one after another: a pg client runs one query at a time, and a `Promise.all` on one client
 * only queues them anyway (and warns "client is already executing a query"). */
export async function serviceImage(client: pg.ClientBase, row: ServiceRow): Promise<ServiceImage> {
  const lines = await client.query<LineImage>(
    `SELECT id, kind, description, trim_scale(quantity)::text AS quantity,
            trim_scale(unit_cost)::text AS unit_cost, sort
       FROM public.service_lines WHERE service_record_id = $1 ORDER BY sort, id`,
    [row.id],
  );
  const completes = await client.query<{ schedule_id: string }>(
    `SELECT schedule_id FROM public.service_completions WHERE service_record_id = $1
      ORDER BY schedule_id`,
    [row.id],
  );
  const reading = await client.query<{ value: string }>(
    'SELECT trim_scale(value)::text AS value FROM public.meter_readings WHERE id = $1',
    [row.meter_reading_id],
  );
  return {
    thing_id: row.thing_id,
    place_id: row.place_id,
    serviced_on: row.serviced_on,
    meter_reading_id: row.meter_reading_id,
    reading_value: reading.rows[0]?.value ?? null,
    vendor_id: row.vendor_id,
    total: row.total,
    currency: row.currency,
    notes: row.notes,
    lines: lines.rows,
    completes: completes.rows.map((c) => c.schedule_id),
  };
}

/** The view of one record the caller can see. */
export async function serviceView(ctx: Ctx, id: string): Promise<ServiceRecord> {
  const { rows } = await ctx.client.query(
    `SELECT ${SERVICE_VIEW_COLUMNS} ${SERVICE_FROM} WHERE r.id = $1`,
    [id],
  );
  if (rows.length === 0) throw notFound();
  const [view] = await serviceRecordsOf(
    ctx.client,
    ctx.files,
    (loc) => gateFor(ctx.tx, loc, ctx.scope),
    rows,
  );
  return view as ServiceRecord;
}

/**
 * A record the caller may change, locked: 404 when they can't see it; their own needs
 * `logs.edit-own`, anyone else's `logs.edit-delete-others` (a 403). The role comes before the
 * lock: under RLS a refused FOR UPDATE finds nothing, which would turn the 403 into a 404.
 */
async function changeableService(ctx: Ctx, id: string): Promise<ServiceRow> {
  const seen = await serviceRow(ctx.client, id);
  const mine = seen.logged_by === ctx.scope.userId;
  await requireRole(
    ctx.client,
    seen.location_id,
    mine ? 'logs.edit-own' : 'logs.edit-delete-others',
  );
  return serviceRow(ctx.client, id, true);
}

async function requireVersion(
  client: pg.ClientBase,
  row: ServiceRow,
  expected: number,
  fields: readonly string[],
): Promise<void> {
  if (row.row_version === expected) return;
  const by = await lastChangedBy(client, row.location_id, { type: 'service_record', id: row.id });
  checkVersion({ rowVersion: row.row_version }, expected, fields, by ? { displayName: by } : null);
}

// ---------------------------------------------------------------------------------------------
// Pieces of a write
// ---------------------------------------------------------------------------------------------

/** The vendor a body names: an existing one of the account (the guard refuses another's: a
 * 404), or a new one by name, created inline (D11, `people-vendors.create-inline`). */
export async function vendorFor(
  ctx: Ctx,
  locationId: string,
  input: VendorInput | null | undefined,
): Promise<string | null> {
  if (!input) return null;
  if ('id' in input) return input.id.toLowerCase();
  const { rows } = await ctx.client.query<{ owner_account_id: string }>(
    'SELECT owner_account_id FROM public.locations WHERE id = $1',
    [locationId],
  );
  const accountId = rows[0]?.owner_account_id;
  if (!accountId) throw notFound();
  const created = await createItem(
    {
      tx: ctx.tx,
      client: ctx.client,
      userId: ctx.scope.userId,
      requestId: ctx.requestId,
      jobs: ctx.jobs,
    },
    'vendors',
    accountId,
    { name: input.name.trim(), kind: 'service_centre' },
  );
  return created.item.id;
}

/** The money a body writes, checked: the gate shows money, the currency is on, and priced lines
 * without a total make one. Returns the total and currency to store. */
async function moneyFor(
  ctx: Ctx,
  locationId: string,
  body: {
    total?: string | null | undefined;
    currency?: string | undefined;
    lines?: LineInput[] | undefined;
  },
  current: { total: string | null; currency: string | null } = { total: null, currency: null },
): Promise<{ total: string | null; currency: string | null; priced: boolean }> {
  const linePriced = (body.lines ?? []).some((l) => l.unitCost !== undefined);
  const touched = body.total !== undefined || body.currency !== undefined || linePriced;
  if (!touched) return { ...current, priced: false };
  const gate = await gateFor(ctx.tx, locationId, ctx.scope);
  if (!gate.showMoney) throw moneyOff();
  let total = body.total !== undefined ? body.total : current.total;
  if (total === null && linePriced) {
    let sum = 0n;
    for (const l of body.lines ?? []) {
      if (l.unitCost === undefined) continue;
      sum += scaled(l.unitCost, 4) * scaled(l.quantity ?? '1', 3);
    }
    total = unscaled(sum, 7, 4);
  }
  const currency = total === null ? null : (body.currency ?? current.currency);
  if (total !== null && !currency) throw invalid('Send body.currency with the amounts.');
  if (currency) await requireCurrencies(ctx.client, [currency], 'body.currency');
  return { total, currency, priced: true };
}

/** A decimal string as an integer scaled by 10^places (exact). */
function scaled(s: string, places: number): bigint {
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole + frac.padEnd(places, '0').slice(0, places));
}

/** An integer scaled by 10^from as a decimal string rounded half up to `to` places. */
function unscaled(v: bigint, from: number, to: number): string {
  const drop = 10n ** BigInt(from - to);
  const rounded = (v + drop / 2n) / drop;
  const s = rounded.toString().padStart(to + 1, '0');
  const whole = s.slice(0, s.length - to);
  const frac = s.slice(s.length - to).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

async function insertLines(
  client: pg.ClientBase,
  locationId: string,
  recordId: string,
  lines: readonly (LineInput & { id?: string })[],
): Promise<void> {
  for (const [i, l] of lines.entries()) {
    await client.query(
      `INSERT INTO public.service_lines (id, location_id, service_record_id, kind, description,
                                         quantity, unit_cost, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        l.id ?? newId(),
        locationId,
        recordId,
        l.kind,
        l.description,
        l.quantity ?? null,
        l.unitCost ?? null,
        i,
      ],
    );
  }
}

/** The schedules a service completes: of its own location, visible, with Schedules on (409
 * `module_off` otherwise). Returns their snooze and skip, which the completion clears, for undo. */
async function completable(
  ctx: Ctx,
  locationId: string,
  ids: readonly string[],
): Promise<
  {
    id: string;
    snoozed_until: string | null;
    snoozed_until_value: string | null;
    skip_next: boolean;
  }[]
> {
  const unique = [...new Set(ids.map((x) => x.toLowerCase()))];
  if (unique.length === 0) return [];
  await requireModule(ctx, locationId, 'schedules', 'write');
  await requireRole(ctx.client, locationId, 'schedules-claims.manage');
  const out = [];
  for (const id of unique) {
    const s = await scheduleRow(ctx.client, id);
    if (s.location_id !== locationId) throw notFound();
    out.push({
      id,
      snoozed_until: s.snoozed_until,
      snoozed_until_value: s.snoozed_until_value,
      skip_next: s.skip_next,
    });
  }
  return out;
}

async function insertCompletions(
  client: pg.ClientBase,
  locationId: string,
  recordId: string,
  scheduleIds: readonly string[],
): Promise<void> {
  for (const id of scheduleIds) {
    await client.query(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [locationId, recordId, id],
    );
  }
}

/** Noon of `day` in the location's zone, as an ISO time (§7.13: a service's reading). */
async function noonOf(client: pg.ClientBase, locationId: string, day: string): Promise<string> {
  const { rows } = await client.query<{ at: Date }>(
    `SELECT (($2::date + time '12:00') AT TIME ZONE l.timezone) AS at
       FROM public.locations l WHERE l.id = $1`,
    [locationId, day],
  );
  return (rows[0]?.at ?? new Date(`${day}T12:00:00Z`)).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export type CreateServiceOptions = {
  /** The action of its audit event: `schedule.complete` from POST …/schedules/:id/complete. */
  action?: string;
};

/**
 * POST /api/v1/service-records ("Log a service") → 201 ServiceRecord, and the heart of
 * POST /api/v1/schedules/:id/complete. Undoable when it completes a schedule (D150: a completion
 * is a change to the schedule; a plain log is a create, removed by DELETE).
 */
export async function createService(
  ctx: Ctx,
  body: CreateServiceInput,
  opts: CreateServiceOptions = {},
): Promise<ServiceRecord> {
  const { client } = ctx;
  const subject = await subjectOfInput(client, body.subject);
  const locationId = subject.locationId;
  await requireRole(client, locationId, 'logs.add');
  const id = body.id ? assertClientId(body.id) : newId();
  if (body.servicedOn > (await todayIn(client, locationId))) {
    throw invalid('Check body.servicedOn: the day it was done, not in the future.');
  }
  if ((body.lines?.length ?? 0) > MAX_LINES)
    throw invalid(`Check body.lines: at most ${MAX_LINES}.`);
  const cleared = await completable(ctx, locationId, body.completes ?? []);
  const money = await moneyFor(ctx, locationId, body);
  const vendorId = await vendorFor(ctx, locationId, body.vendor);

  let readingId: string | null = null;
  if (body.reading) {
    // A meter of this thing (the reading is its), through the meters' own entry: refused at entry
    // when it runs backwards (409 with the neighbour), as the meters section is.
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.meters WHERE id = $1 AND thing_id = $2',
      [body.reading.meterId, subject.thingId],
    );
    if (!subject.thingId || !rowCount) throw notFound();
    const takenAt = body.reading.takenAt ?? (await noonOf(client, locationId, body.servicedOn));
    const made = await createReading(ctx, body.reading.meterId.toLowerCase(), {
      value: body.reading.value,
      takenAt,
    });
    readingId = made.reading.id;
    if (body.reading.proofFileId) {
      await createAttachment(
        ctx.tx,
        client,
        ctx.files,
        (loc) => gateFor(ctx.tx, loc, ctx.scope),
        ctx.scope.userId,
        {
          id: newId(),
          locationId,
          fileId: body.reading.proofFileId,
          subject: { meterReadingId: readingId },
          role: 'proof',
        },
        ctx.requestId,
      );
    }
  }

  await client.query(
    `INSERT INTO public.service_records (id, location_id, thing_id, place_id, serviced_on,
                                         meter_reading_id, vendor_id, total, currency, notes,
                                         logged_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, kept.current_user_id())`,
    [
      id,
      locationId,
      subject.thingId,
      subject.placeId,
      body.servicedOn,
      readingId,
      vendorId,
      money.total,
      money.currency,
      body.notes ?? null,
    ],
  );
  await insertLines(client, locationId, id, body.lines ?? []);
  await insertCompletions(
    client,
    locationId,
    id,
    cleared.map((c) => c.id),
  );
  const after = await serviceImage(client, await serviceRow(client, id));
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx),
    action: opts.action ?? 'service_record.create',
    entity: { type: 'service_record', id },
    // What the completion cleared (Q28), and whether the reading is this record's own: undo puts
    // the one back and removes the other.
    before: cleared.length > 0 ? { cleared_schedules: cleared } : null,
    after: { ...after, reading_created: readingId !== null },
    fieldClasses: CLASSES,
    subjects: subject.thingId ? [subject.thingId] : [],
    rootThingId: subject.thingId,
    requestId: ctx.requestId,
    ...(cleared.length > 0 ? { undoableUntil: undoableUntil() } : {}),
  });
  return serviceView(ctx, id);
}

// ---------------------------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------------------------

export type CompleteInput = {
  servicedOn?: string | undefined;
  reading?: { value: string; takenAt?: string | undefined } | undefined;
  vendor?: VendorInput | undefined;
  total?: string | undefined;
  currency?: string | undefined;
  notes?: string | undefined;
};

/**
 * POST /api/v1/schedules/:id/complete (If-Match on the schedule) → {serviceRecord, schedule}: a
 * service record on the schedule's subject that completes it (D29), which re-anchors it (0053).
 * The reading is of the schedule's meter. Undo removes the record (and its reading), and the
 * anchor, snooze and skip fall back.
 */
export async function completeSchedule(
  ctx: Ctx,
  id: string,
  expected: number,
  body: CompleteInput,
): Promise<{ serviceRecord: ServiceRecord; schedule: Schedule }> {
  const s = await writableSchedule(ctx, id);
  if (s.row_version !== expected) {
    const by = await lastChangedBy(ctx.client, s.location_id, { type: 'schedule', id });
    checkVersion(
      { rowVersion: s.row_version },
      expected,
      ['complete'],
      by ? { displayName: by } : null,
    );
  }
  if (body.reading && !s.meter_id) {
    throw invalid('Check body.reading: this schedule counts no meter.');
  }
  const serviceRecord = await createService(ctx, {
    subject: s.thing_id ? { thingId: s.thing_id } : { placeId: s.place_id as string },
    servicedOn: body.servicedOn ?? (await todayIn(ctx.client, s.location_id)),
    ...(body.reading && s.meter_id
      ? {
          reading: {
            meterId: s.meter_id,
            value: body.reading.value,
            takenAt: body.reading.takenAt,
          },
        }
      : {}),
    vendor: body.vendor,
    total: body.total,
    currency: body.currency,
    notes: body.notes,
    completes: [id],
  });
  return { serviceRecord, schedule: await scheduleView(ctx.client, id) };
}

// ---------------------------------------------------------------------------------------------
// Confirm a draft (step 5, T9)
// ---------------------------------------------------------------------------------------------

/** 409 `service_draft`: a draft is finished (confirmed) before it is changed or used. */
export const draftFirst = () =>
  new AppError('service_draft', 409, 'Finish logging this service, or delete the draft.');

/** POST /api/v1/service-records/:id/confirm: step 4's create body, without `id` and `subject`. */
export type ConfirmServiceInput = Omit<CreateServiceInput, 'id' | 'subject'>;

/**
 * POST /api/v1/service-records/:id/confirm (If-Match) → ServiceRecord: a draft becomes the
 * service the form says, under step 4's create rules (the reading through the meters' entry,
 * refused at entry with 409 `conflict` and its neighbour; lines, money and `completes`), and
 * counts from then on (0063's triggers re-anchor what it completes). A refusal writes nothing, so
 * it stays a draft. Audited `service_record.confirm`, undoable: undo makes it a draft again.
 */
export async function confirmService(
  ctx: Ctx,
  id: string,
  expected: number,
  body: ConfirmServiceInput,
): Promise<ServiceRecord> {
  const { client } = ctx;
  const row = await changeableService(ctx, id);
  if (row.review_state !== 'draft') throw conflict('This service is already logged.');
  await requireVersion(client, row, expected, ['reviewState']);
  const locationId = row.location_id;
  if (body.servicedOn > (await todayIn(client, locationId))) {
    throw invalid('Check body.servicedOn: the day it was done, not in the future.');
  }
  if ((body.lines?.length ?? 0) > MAX_LINES)
    throw invalid(`Check body.lines: at most ${MAX_LINES}.`);
  const before = await serviceImage(client, row);
  const cleared = await completable(ctx, locationId, body.completes ?? []);
  // The draft holds no money of its own (its invoice's amounts are suggestions): only what the
  // form sends is written, with an enabled currency (requireCurrencies).
  const money = await moneyFor(ctx, locationId, body);
  const vendorId = await vendorFor(ctx, locationId, body.vendor);

  let readingId: string | null = row.meter_reading_id;
  let readingCreated = false;
  if (body.reading) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.meters WHERE id = $1 AND thing_id = $2',
      [body.reading.meterId, row.thing_id],
    );
    if (!row.thing_id || !rowCount) throw notFound();
    const takenAt = body.reading.takenAt ?? (await noonOf(client, locationId, body.servicedOn));
    const made = await createReading(ctx, body.reading.meterId.toLowerCase(), {
      value: body.reading.value,
      takenAt,
    });
    readingId = made.reading.id;
    readingCreated = true;
    if (body.reading.proofFileId) {
      await createAttachment(
        ctx.tx,
        client,
        ctx.files,
        (loc) => gateFor(ctx.tx, loc, ctx.scope),
        ctx.scope.userId,
        {
          id: newId(),
          locationId,
          fileId: body.reading.proofFileId,
          subject: { meterReadingId: readingId },
          role: 'proof',
        },
        ctx.requestId,
      );
    }
  }

  await client.query(
    `UPDATE public.service_records
        SET serviced_on = $2, meter_reading_id = $3, vendor_id = $4, total = $5, currency = $6,
            notes = $7, review_state = 'confirmed'
      WHERE id = $1`,
    [id, body.servicedOn, readingId, vendorId, money.total, money.currency, body.notes ?? null],
  );
  await client.query('DELETE FROM public.service_lines WHERE service_record_id = $1', [id]);
  await insertLines(client, locationId, id, body.lines ?? []);
  await insertCompletions(
    client,
    locationId,
    id,
    cleared.map((c) => c.id),
  );
  const after = await serviceImage(client, await serviceRow(client, id));
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx),
    action: 'service_record.confirm',
    entity: { type: 'service_record', id },
    // What the completion cleared (Q28) and whether the reading is the confirm's own: undo puts
    // the one back and removes the other, and the record is a draft again.
    before: {
      ...before,
      review_state: 'draft',
      ...(cleared.length > 0 ? { cleared_schedules: cleared } : {}),
    },
    after: { ...after, review_state: 'confirmed', reading_created: readingCreated },
    fieldClasses: CLASSES,
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  return serviceView(ctx, id);
}

// ---------------------------------------------------------------------------------------------
// Update and delete
// ---------------------------------------------------------------------------------------------

export type UpdateServiceInput = {
  servicedOn?: string | undefined;
  reading?: { meterId: string; value: string; proofFileId?: string | undefined } | undefined;
  vendor?: VendorInput | null | undefined;
  total?: string | null | undefined;
  currency?: string | undefined;
  lines?: LineInput[] | undefined;
  completes?: string[] | undefined;
  notes?: string | null | undefined;
};

/**
 * PATCH /api/v1/service-records/:id (If-Match) → ServiceRecord. `lines` and `completes` replace
 * the record's; a new reading value goes through the meters' check (409 when it runs backwards).
 * Audited `service_record.update`, undoable.
 */
export async function updateService(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateServiceInput,
): Promise<ServiceRecord> {
  const { client } = ctx;
  const row = await changeableService(ctx, id);
  if (row.review_state === 'draft') throw draftFirst();
  const fields = (Object.keys(body) as (keyof UpdateServiceInput)[]).filter(
    (k) => body[k] !== undefined,
  );
  await requireVersion(client, row, expected, fields);
  if (fields.length === 0) return serviceView(ctx, id);
  const before = await serviceImage(client, row);
  const locationId = row.location_id;
  const servicedOn = body.servicedOn ?? row.serviced_on;
  if (servicedOn > (await todayIn(client, locationId))) {
    throw invalid('Check body.servicedOn: the day it was done, not in the future.');
  }
  if ((body.lines?.length ?? 0) > MAX_LINES)
    throw invalid(`Check body.lines: at most ${MAX_LINES}.`);
  if (body.completes !== undefined) {
    const added = body.completes.filter((s) => !before.completes.includes(s.toLowerCase()));
    if (added.length > 0 || body.completes.length !== before.completes.length) {
      await completable(ctx, locationId, body.completes);
    }
  }
  // A hidden amount can't be cleared by someone who never saw it: clearing is a money write too.
  const money = await moneyFor(ctx, locationId, body, { total: row.total, currency: row.currency });
  const vendorId =
    body.vendor === undefined ? row.vendor_id : await vendorFor(ctx, locationId, body.vendor);

  let readingId = row.meter_reading_id;
  let readingCreated = false;
  if (body.reading) {
    const { rows: m } = await client.query<{ thing_id: string }>(
      'SELECT thing_id FROM public.meters WHERE id = $1',
      [body.reading.meterId],
    );
    if (!row.thing_id || m[0]?.thing_id !== row.thing_id) throw notFound();
    const { rows: current } = await client.query<{ meter_id: string }>(
      'SELECT meter_id FROM public.meter_readings WHERE id = $1',
      [row.meter_reading_id],
    );
    if (readingId && current[0]?.meter_id === body.reading.meterId.toLowerCase()) {
      // The service owns its reading (Q11): changed here, through its owner.
      await updateReading(ctx, readingId, { value: body.reading.value }, null, { owned: 'allow' });
    } else {
      const made = await createReading(ctx, body.reading.meterId.toLowerCase(), {
        value: body.reading.value,
        takenAt: await noonOf(client, locationId, servicedOn),
      });
      readingId = made.reading.id;
      readingCreated = true;
    }
  }

  await client.query(
    `UPDATE public.service_records
        SET serviced_on = $2, meter_reading_id = $3, vendor_id = $4, total = $5, currency = $6,
            notes = CASE WHEN $7 THEN $8 ELSE notes END
      WHERE id = $1`,
    [
      id,
      servicedOn,
      readingId,
      vendorId,
      money.total,
      money.currency,
      body.notes !== undefined,
      body.notes ?? null,
    ],
  );
  if (body.lines !== undefined) {
    await client.query('DELETE FROM public.service_lines WHERE service_record_id = $1', [id]);
    await insertLines(client, locationId, id, body.lines);
  }
  if (body.completes !== undefined) {
    const want = [...new Set(body.completes.map((s) => s.toLowerCase()))];
    await client.query(
      `DELETE FROM public.service_completions
        WHERE service_record_id = $1 AND NOT (schedule_id = ANY ($2::uuid[]))`,
      [id, want],
    );
    await insertCompletions(client, locationId, id, want);
  }
  const after = await serviceImage(client, await serviceRow(client, id));
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx),
    action: 'service_record.update',
    entity: { type: 'service_record', id },
    before,
    after: { ...after, ...(readingCreated ? { reading_created: true } : {}) },
    fieldClasses: CLASSES,
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  return serviceView(ctx, id);
}

/** An attachment's image, for putting it back after an undone delete (the files stay a day). */
type AttachmentImage = {
  id: string;
  file_id: string | null;
  url: string | null;
  role: string;
  sort: number;
};

/**
 * DELETE /api/v1/service-records/:id (If-Match) → 204. Hard (Q25): its lines, completions (the
 * anchors fall back, D162) and files go with it; its reading stays on the meter. Undoable: the
 * event holds all of it.
 */
export async function deleteService(ctx: Ctx, id: string, expected: number): Promise<void> {
  const { client } = ctx;
  const row = await changeableService(ctx, id);
  await requireVersion(client, row, expected, []);
  const image = await serviceImage(client, row);
  const { rows: attachments } = await client.query<AttachmentImage>(
    `SELECT id, file_id, url, role, sort FROM public.attachments WHERE service_record_id = $1
      ORDER BY sort, id`,
    [id],
  );
  const draft = row.review_state === 'draft';
  // Removing an invoice where money is hidden would erase what the caller can't see; a draft's
  // own logger attached its invoice, and drops it (with its read) at any time (Q12).
  const ownDraft = draft && row.logged_by === ctx.scope.userId;
  if (
    !ownDraft &&
    (attachments.some((a) => a.role === 'invoice' || a.role === 'receipt') || row.total !== null)
  ) {
    if (!(await gateFor(ctx.tx, row.location_id, ctx.scope)).showMoney) throw moneyOff();
  }
  await client.query('DELETE FROM public.service_records WHERE id = $1', [id]);
  await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actor(ctx),
    action: 'service_record.delete',
    entity: { type: 'service_record', id },
    before: { ...image, attachments, ...(draft ? { review_state: 'draft' } : {}) },
    after: null,
    fieldClasses: CLASSES,
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    // A draft's read (its extraction) goes with it and can't come back: not undoable.
    ...(draft ? {} : { undoableUntil: undoableUntil() }),
  });
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

/** GET /api/v1/{things|places}/:id/service-records: the `services` surface's filters (step 5). */
export type ServiceListQuery = {
  limit: number;
  cursor?: string | undefined;
  q?: string | undefined;
  'f.when'?: string | undefined;
  'f.vendor'?: string[] | undefined;
  'f.kind'?: ServiceLineKind[] | undefined;
  /** `1`: drafts only; `0`: confirmed only. */
  'f.draft'?: '0' | '1' | undefined;
  /** Filters answered "is none of" (D205). */
  not?: ('when' | 'vendor' | 'kind' | 'draft')[] | undefined;
  sort?: 'servicedOn' | 'total' | undefined;
  dir?: 'asc' | 'desc' | undefined;
};

/**
 * GET /api/v1/{things|places}/:id/service-records → `{items, next_cursor}`: drafts first (they
 * wait to be finished, "Draft · finish logging"), then by the sort, newest first unless `dir`
 * says otherwise. `sort=total` orders by the amount where the caller sees money, else by date
 * (an order is money too). `q` looks in the vendor, the notes and the lines.
 */
export async function subjectServices(
  ctx: Ctx,
  input: SubjectInput,
  page: ServiceListQuery,
): Promise<{ items: ServiceRecord[]; next_cursor: string | null }> {
  const subject = await subjectOfInput(ctx.client, input);
  const byTotal =
    page.sort === 'total' && (await gateFor(ctx.tx, subject.locationId, ctx.scope)).showMoney;
  const asc = page.dir === 'asc';
  let after: [number, string, string] | null = null;
  if (page.cursor) {
    const raw = decodeCursor<unknown>(page.cursor);
    if (
      !Array.isArray(raw) ||
      raw.length !== 3 ||
      typeof raw[0] !== 'number' ||
      typeof raw[1] !== 'string' ||
      typeof raw[2] !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(raw[2]) ||
      !(byTotal ? /^\d{1,12}(\.\d{1,4})?$/ : /^\d{4}-\d{2}-\d{2}$/).test(raw[1])
    ) {
      throw invalid('The cursor is not valid; start again from the first page.');
    }
    after = raw as [number, string, string];
  }
  const args: unknown[] = [subject.thingId ?? subject.placeId];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  const not = new Set(page.not ?? []);
  const where = [subject.thingId ? 'r.thing_id = $1' : 'r.place_id = $1'];
  const filter = (name: string, cond: string) =>
    where.push(not.has(name as never) ? `NOT coalesce(${cond}, false)` : cond);
  const when = page['f.when'];
  if (when) {
    if (!isDateFilterValue(when)) {
      throw invalid('f.when is today, week, month, year or YYYY-MM-DD..YYYY-MM-DD.');
    }
    const { from, to } = whenDays(when, await todayIn(ctx.client, subject.locationId));
    const parts = [
      ...(from ? [`r.serviced_on >= ${arg(from)}::date`] : []),
      ...(to ? [`r.serviced_on <= ${arg(to)}::date`] : []),
    ];
    if (parts.length > 0) filter('when', `(${parts.join(' AND ')})`);
  }
  const vendors = page['f.vendor'];
  if (vendors?.length) {
    filter('vendor', `r.vendor_id = ANY (${arg(vendors.map((v) => v.toLowerCase()))}::uuid[])`);
  }
  const kinds = page['f.kind'];
  if (kinds?.length) {
    filter(
      'kind',
      `EXISTS (SELECT 1 FROM public.service_lines l
                WHERE l.service_record_id = r.id AND l.kind = ANY (${arg(kinds)}::text[]))`,
    );
  }
  if (page['f.draft']) {
    filter('draft', `r.review_state ${page['f.draft'] === '1' ? '=' : '<>'} 'draft'`);
  }
  const q = page.q?.trim();
  if (q) {
    where.push(
      `strpos(kept.normalize(concat_ws(' ', v.name, r.notes,
         (SELECT string_agg(l.description, ' ') FROM public.service_lines l
           WHERE l.service_record_id = r.id))), kept.normalize(${arg(q)})) > 0`,
    );
  }
  const rank = `(r.review_state = 'draft')::int`;
  const key = byTotal ? 'coalesce(r.total, 0)' : 'r.serviced_on';
  const keyText = byTotal ? 'trim_scale(coalesce(r.total, 0))::text' : 'r.serviced_on::text';
  const cmp = asc ? '>' : '<';
  if (after) {
    const [r0, k0, id0] = [arg(after[0]), arg(after[1]), arg(after[2])];
    const cast = byTotal ? 'numeric' : 'date';
    where.push(
      `(${rank} < ${r0} OR (${rank} = ${r0} AND (${key}, r.id) ${cmp} (${k0}::${cast}, ${id0}::uuid)))`,
    );
  }
  const dir = asc ? 'ASC' : 'DESC';
  const { rows } = await ctx.client.query<{ id: string; sort_rank: number; sort_key: string }>(
    `SELECT ${SERVICE_VIEW_COLUMNS}, ${rank} AS sort_rank, ${keyText} AS sort_key
       ${SERVICE_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY sort_rank DESC, ${key} ${dir}, r.id ${dir}
      LIMIT ${arg(page.limit + 1)}`,
    args,
  );
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: await serviceRecordsOf(
      ctx.client,
      ctx.files,
      (loc) => gateFor(ctx.tx, loc, ctx.scope),
      items,
    ),
    next_cursor:
      rows.length > page.limit && last
        ? encodeCursor([last.sort_rank, last.sort_key, last.id])
        : null,
  };
}
