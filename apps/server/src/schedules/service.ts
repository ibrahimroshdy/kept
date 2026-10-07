import { type Action, type ModuleId, newId, type Role } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import {
  assertClientId,
  checkVersion,
  decodeCursor,
  encodeCursor,
  PAGE_DEFAULT,
} from '../http/conventions.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { requireRole } from '../things/service.js';
import {
  SCHEDULE_COLUMNS,
  type Schedule,
  type ScheduleRow,
  type ScheduleState,
  scheduleImage,
  schedulesOf,
  schedulesWhere,
  scheduleView,
  scheduleViewColumns,
} from './view.js';

// Schedules on things and places (plan T11; D29, D39, D52, D146, D162; Q2, Q9, Q28). Every
// function runs in the request's scoped kept_app transaction: RLS decides what exists (a 404
// otherwise), the Schedules module whether the location has them (404 on a read, 409 on a write,
// §7.6), and can() what the caller's role may do (`schedules-claims.manage`, a 403).
//
// - A schedule is "every N months and/or every N units of the thing's meter, whichever first", or
//   once on a date. Its anchor is kept in SQL (0053: kept.recompute_schedule_anchor()): the
//   latest completing service, else the base it was made with (`anchorOn`/`anchorValue` here,
//   `base_on`/`base_value` in the table). No request writes the anchor itself.
// - Snooze replaces the due point until the next completion; skip moves it one interval on
//   (Q28); completing clears both (the completion trigger, 0053).
// - `next` is SQL's (kept.schedule_next(), the agenda view's function), never computed here.
// - Deletes are hard (Q25): the event holds the whole row, and undo puts it back with its id.

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  files: FileStorage | null;
  jobs: JobQueue | null;
};

const actor = (scope: Scope) => actorOf(scope);
const MODULE: ModuleId = 'schedules';

/** 404 `module_off` on a read, 409 on a write, where the location has `module` off (§7.6). */
export async function requireModule(
  ctx: Pick<Ctx, 'tx' | 'scope'>,
  locationId: string,
  module: ModuleId,
  mode: 'read' | 'write',
): Promise<void> {
  const gate = await gateFor(ctx.tx, locationId, ctx.scope);
  if (!gate.modules.has(module)) {
    throw new AppError('module_off', mode === 'read' ? 404 : 409);
  }
}

/** Today in the location's zone, `YYYY-MM-DD` (§7.13: "today" is the location's). */
export async function todayIn(client: pg.ClientBase, locationId: string): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE l.timezone)::date::text AS today
       FROM public.locations l WHERE l.id = $1`,
    [locationId],
  );
  const today = rows[0]?.today;
  if (!today) throw notFound();
  return today;
}

export type SubjectInput = { thingId: string } | { placeId: string };
export type Subject = { locationId: string; thingId: string | null; placeId: string | null };

/** A live thing or place the caller can see, with its location; 404 otherwise. */
export async function subjectOfInput(client: pg.ClientBase, input: SubjectInput): Promise<Subject> {
  if ('thingId' in input) {
    const id = input.thingId.toLowerCase();
    const { rows } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    const loc = rows[0]?.location_id;
    if (!loc) throw notFound();
    return { locationId: loc, thingId: id, placeId: null };
  }
  const id = input.placeId.toLowerCase();
  const { rows } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.places WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  const loc = rows[0]?.location_id;
  if (!loc) throw notFound();
  return { locationId: loc, thingId: null, placeId: id };
}

async function scheduleRow(client: pg.ClientBase, id: string, lock = false): Promise<ScheduleRow> {
  const { rows } = await client.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM public.schedules s WHERE s.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * A schedule the caller may change, locked: 404 when they can't see it, `module_off` when the
 * module is off there, 403 unless their role may. The role is checked before the lock: under RLS
 * a viewer's FOR UPDATE finds nothing, which would turn their 403 into a 404.
 */
export async function writableSchedule(
  ctx: Ctx,
  id: string,
  action: Action = 'schedules-claims.manage',
): Promise<ScheduleRow & { role: Role }> {
  const seen = await scheduleRow(ctx.client, id);
  await requireModule(ctx, seen.location_id, MODULE, 'write');
  const role = await requireRole(ctx.client, seen.location_id, action);
  return { ...(await scheduleRow(ctx.client, id, true)), role };
}

/** 412 (D156) unless the schedule is at `expected`, naming who changed it since. */
async function requireVersion(
  client: pg.ClientBase,
  row: ScheduleRow,
  expected: number,
  fields: readonly string[],
): Promise<void> {
  if (row.row_version === expected) return;
  const by = await lastChangedBy(client, row.location_id, { type: 'schedule', id: row.id });
  checkVersion({ rowVersion: row.row_version }, expected, fields, by ? { displayName: by } : null);
}

/** The subject's things, for the audit (its history shows the schedule, D45). */
const subjectsOf = (r: { thing_id: string | null }) => (r.thing_id ? [r.thing_id] : []);

async function auditSchedule(
  ctx: Ctx,
  action: string,
  before: ScheduleRow | null,
  after: ScheduleRow | null,
  undoable: boolean,
): Promise<void> {
  const row = (after ?? before) as ScheduleRow;
  await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actor(ctx.scope),
    action,
    entity: { type: 'schedule', id: row.id },
    before: before ? scheduleImage(before) : null,
    after: after ? scheduleImage(after) : null,
    subjects: subjectsOf(row),
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    ...(undoable ? { undoableUntil: undoableUntil() } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------------------------

export type RuleInput = {
  everyMonths?: number | null | undefined;
  everyUnits?: string | null | undefined;
  meterId?: string | null | undefined;
  dueOn?: string | null | undefined;
};

/**
 * A rule as the table's checks want it, said as a 400 with the field before the database does:
 * an interval in months or units, or a date (screens §7: `schedule_interval_required`); a unit
 * interval needs a meter of the thing itself; a date is only for a one-off.
 */
async function checkRule(
  client: pg.ClientBase,
  subject: Subject,
  rule: {
    everyMonths: number | null;
    everyUnits: string | null;
    meterId: string | null;
    dueOn: string | null;
  },
): Promise<void> {
  if (rule.everyMonths === null && rule.everyUnits === null && rule.dueOn === null) {
    throw new AppError(
      'schedule_interval_required',
      400,
      'Set how often: every so many months or units, or a date.',
    );
  }
  if (rule.dueOn !== null && (rule.everyMonths !== null || rule.everyUnits !== null)) {
    throw invalid('Check body.dueOn: a date is for a one-off, without an interval.');
  }
  if ((rule.everyUnits === null) !== (rule.meterId === null)) {
    throw invalid('Check body.meterId: an interval in units needs the meter it counts on.');
  }
  if (rule.meterId !== null) {
    if (!subject.thingId) throw invalid('Check body.meterId: only a thing has a meter.');
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.meters WHERE id = $1 AND thing_id = $2',
      [rule.meterId, subject.thingId],
    );
    if (!rowCount) throw notFound();
  }
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export type ScheduleListQuery = {
  locationId?: string | undefined;
  state?: ScheduleState | undefined;
  subjectType?: 'thing' | 'place' | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

const RANK_SQL = `CASE a.state WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 ELSE 2 END`;
const DUE_SQL = `coalesce(a.due_on, DATE '9999-12-31')`;

/**
 * GET /api/v1/schedules: the Schedules screen, across every location the caller sees with the
 * module on (screens §1), overdue first, then due, then upcoming, soonest first. It reads the
 * agenda view (plan Q24), so its rows and counts are the ones Home and the reminder scan see:
 * an inactive schedule, a trashed or ended subject, or the module off leaves it out.
 */
export async function listSchedules(
  client: pg.ClientBase,
  query: ScheduleListQuery,
): Promise<{
  items: Schedule[];
  counts: { due: number; overdue: number };
  next_cursor: string | null;
}> {
  const limit = query.limit ?? PAGE_DEFAULT;
  let after: [number, string, string] | null = null;
  if (query.cursor) {
    const raw = decodeCursor<unknown>(query.cursor);
    if (
      !Array.isArray(raw) ||
      raw.length !== 3 ||
      typeof raw[0] !== 'number' ||
      typeof raw[1] !== 'string' ||
      typeof raw[2] !== 'string'
    ) {
      throw invalid('The cursor is not valid; start again from the first page.');
    }
    after = raw as [number, string, string];
  }
  const q = query.q?.trim() ? query.q.trim() : null;
  const base = `FROM public.agenda_items a
    JOIN public.schedules s ON s.id = a.source_id
    JOIN public.locations l ON l.id = s.location_id
    LEFT JOIN public.meters m ON m.id = s.meter_id
    LEFT JOIN public.things t ON t.id = s.thing_id
    LEFT JOIN public.places p ON p.id = s.place_id
   WHERE a.source_type = 'schedule'
     AND ($1::uuid IS NULL OR a.location_id = $1)
     AND ($2::text IS NULL OR (CASE WHEN s.thing_id IS NULL THEN 'place' ELSE 'thing' END) = $2)
     AND ($3::text IS NULL
          OR strpos(kept.normalize(s.name), kept.normalize($3)) > 0
          OR strpos(kept.normalize(coalesce(t.name, p.name, '')), kept.normalize($3)) > 0)`;
  const params = [query.locationId?.toLowerCase() ?? null, query.subjectType ?? null, q];
  const { rows: counted } = await client.query<{ due: number; overdue: number }>(
    `SELECT count(*) FILTER (WHERE a.state = 'due')::int AS due,
            count(*) FILTER (WHERE a.state = 'overdue')::int AS overdue ${base}`,
    params,
  );
  // The agenda row's state is the schedule's next state (the same kept.schedule_point()).
  const { rows } = await client.query<
    Record<string, unknown> & { rank: number; due: string; id: string }
  >(
    `SELECT ${scheduleViewColumns({ dueOn: 'a.due_on', dueValue: 'a.due_value', state: 'a.state' })},
            ${RANK_SQL} AS rank, ${DUE_SQL}::text AS due
       ${base}
       AND ($4::text IS NULL OR a.state = $4)
       AND ($5::int IS NULL OR (${RANK_SQL}, ${DUE_SQL}, s.id) > ($5::int, $6::date, $7::uuid))
     ORDER BY ${RANK_SQL}, ${DUE_SQL}, s.id
     LIMIT $8`,
    [
      ...params,
      query.state ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      after?.[2] ?? null,
      limit + 1,
    ],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: schedulesOf(page),
    counts: counted[0] ?? { due: 0, overdue: 0 },
    next_cursor: rows.length > limit && last ? encodeCursor([last.rank, last.due, last.id]) : null,
  };
}

/** GET /api/v1/{things|places}/:id/schedules: every schedule of the subject, active or not. */
export async function subjectSchedules(
  ctx: Pick<Ctx, 'tx' | 'client' | 'scope'>,
  input: SubjectInput,
): Promise<{ items: Schedule[] }> {
  const subject = await subjectOfInput(ctx.client, input);
  await requireModule(ctx, subject.locationId, MODULE, 'read');
  const column = subject.thingId ? 's.thing_id' : 's.place_id';
  const items = await schedulesWhere(
    ctx.client,
    `${column} = $1`,
    [subject.thingId ?? subject.placeId],
    `s.active DESC, CASE n.state WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 ELSE 2 END,
     coalesce(n.due_on, DATE '9999-12-31'), s.created_at, s.id`,
  );
  return { items };
}

// ---------------------------------------------------------------------------------------------
// Create, update, delete
// ---------------------------------------------------------------------------------------------

export type CreateScheduleInput = {
  id?: string | undefined;
  subject: SubjectInput;
  name: string;
  everyMonths?: number | undefined;
  everyUnits?: string | undefined;
  meterId?: string | undefined;
  dueOn?: string | undefined;
  leadDays?: number | undefined;
  leadUnits?: string | undefined;
  anchorOn?: string | undefined;
  anchorValue?: string | undefined;
};

/** POST /api/v1/schedules → 201 Schedule. */
export async function createSchedule(ctx: Ctx, body: CreateScheduleInput): Promise<Schedule> {
  const { client } = ctx;
  const subject = await subjectOfInput(client, body.subject);
  await requireModule(ctx, subject.locationId, MODULE, 'write');
  await requireRole(client, subject.locationId, 'schedules-claims.manage');
  const id = body.id ? assertClientId(body.id) : newId();
  const meterId = body.meterId?.toLowerCase() ?? null;
  await checkRule(client, subject, {
    everyMonths: body.everyMonths ?? null,
    everyUnits: body.everyUnits ?? null,
    meterId,
    dueOn: body.dueOn ?? null,
  });
  const today = await todayIn(client, subject.locationId);
  const anchorOn = body.anchorOn ?? today;
  if (anchorOn > today)
    throw invalid('Check body.anchorOn: when it was last done, not in the future.');
  // The count starts from the meter's newest accepted reading (with its offset, D52), unless the
  // request says what it read when last done.
  let anchorValue = body.anchorValue ?? null;
  if (anchorValue === null && meterId) {
    const { rows } = await client.query<{ v: string | null }>(
      'SELECT trim_scale(kept.meter_latest($1))::text AS v',
      [meterId],
    );
    anchorValue = rows[0]?.v ?? null;
  }
  await client.query(
    `INSERT INTO public.schedules (id, location_id, thing_id, place_id, name, every_months,
                                   every_units, meter_id, due_on, lead_days, lead_units, base_on,
                                   base_value, anchor_on, anchor_value, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, 14), $11, $12, $13, $12, $13,
             kept.current_user_id())`,
    [
      id,
      subject.locationId,
      subject.thingId,
      subject.placeId,
      body.name,
      body.everyMonths ?? null,
      body.everyUnits ?? null,
      meterId,
      body.dueOn ?? null,
      body.leadDays ?? null,
      body.leadUnits ?? null,
      anchorOn,
      anchorValue,
    ],
  );
  await auditSchedule(ctx, 'schedule.create', null, await scheduleRow(client, id), false);
  return scheduleView(client, id);
}

export type UpdateScheduleInput = {
  name?: string | undefined;
  everyMonths?: number | null | undefined;
  everyUnits?: string | null | undefined;
  meterId?: string | null | undefined;
  dueOn?: string | null | undefined;
  leadDays?: number | undefined;
  leadUnits?: string | null | undefined;
  anchorOn?: string | undefined;
  anchorValue?: string | null | undefined;
  active?: boolean | undefined;
};

/** The body's fields, as columns (`anchorOn`/`anchorValue` tell the base again, D162). */
const UPDATE_COLUMNS: Record<keyof UpdateScheduleInput, string> = {
  name: 'name',
  everyMonths: 'every_months',
  everyUnits: 'every_units',
  meterId: 'meter_id',
  dueOn: 'due_on',
  leadDays: 'lead_days',
  leadUnits: 'lead_units',
  anchorOn: 'base_on',
  anchorValue: 'base_value',
  active: 'active',
};

/** PATCH /api/v1/schedules/:id (If-Match) → Schedule. Audited `schedule.update`, undoable. */
export async function updateSchedule(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateScheduleInput,
): Promise<Schedule> {
  const { client } = ctx;
  const before = await writableSchedule(ctx, id);
  const fields = (Object.keys(body) as (keyof UpdateScheduleInput)[]).filter(
    (k) => body[k] !== undefined,
  );
  await requireVersion(client, before, expected, fields);
  if (fields.length === 0) return scheduleView(client, id);
  const pick = <K extends keyof UpdateScheduleInput, V>(k: K, current: V) =>
    body[k] !== undefined ? (body[k] as V) : current;
  const meterId = pick('meterId', before.meter_id);
  const subject: Subject = {
    locationId: before.location_id,
    thingId: before.thing_id,
    placeId: before.place_id,
  };
  await checkRule(client, subject, {
    everyMonths: pick('everyMonths', before.every_months),
    everyUnits: pick('everyUnits', before.every_units),
    meterId: meterId ? meterId.toLowerCase() : null,
    dueOn: pick('dueOn', before.due_on),
  });
  if (body.anchorOn !== undefined && body.anchorOn > (await todayIn(client, before.location_id))) {
    throw invalid('Check body.anchorOn: when it was last done, not in the future.');
  }
  const sets = fields.map((f, i) => `${UPDATE_COLUMNS[f]} = $${i + 2}`);
  await client.query(`UPDATE public.schedules SET ${sets.join(', ')} WHERE id = $1`, [
    id,
    ...fields.map((f) => (f === 'meterId' && body.meterId ? body.meterId.toLowerCase() : body[f])),
  ]);
  await auditSchedule(ctx, 'schedule.update', before, await scheduleRow(client, id), true);
  return scheduleView(client, id);
}

/** DELETE /api/v1/schedules/:id (If-Match) → 204. Hard (Q25); undoable (the row comes back). */
export async function deleteSchedule(ctx: Ctx, id: string, expected: number): Promise<void> {
  const before = await writableSchedule(ctx, id);
  await requireVersion(ctx.client, before, expected, []);
  const { rows: completions } = await ctx.client.query<{ service_record_id: string }>(
    'SELECT service_record_id FROM public.service_completions WHERE schedule_id = $1',
    [id],
  );
  await ctx.client.query('DELETE FROM public.schedules WHERE id = $1', [id]);
  await audited(ctx.tx, {
    locationId: before.location_id,
    actor: actor(ctx.scope),
    action: 'schedule.delete',
    entity: { type: 'schedule', id },
    before: {
      ...scheduleImage(before),
      created_by: before.created_by,
      completed_by: completions.map((c) => c.service_record_id),
    },
    after: null,
    subjects: subjectsOf(before),
    rootThingId: before.thing_id,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
}

// ---------------------------------------------------------------------------------------------
// Snooze, skip, unsnooze
// ---------------------------------------------------------------------------------------------

export type SnoozeInput = { untilDate: string } | { untilValue: string } | Record<string, never>;

/**
 * POST /api/v1/schedules/:id/snooze (If-Match) → Schedule: to a date, or to a reading (`{}` on a
 * unit schedule: +10% of the interval past the current due reading, screens §8). The snooze
 * replaces the due point until the next completion (Q28). Audited `schedule.snooze`, undoable.
 */
export async function snoozeSchedule(
  ctx: Ctx,
  id: string,
  expected: number,
  body: SnoozeInput,
): Promise<Schedule> {
  const { client } = ctx;
  const before = await writableSchedule(ctx, id);
  await requireVersion(client, before, expected, Object.keys(body));
  let untilDate: string | null = null;
  let untilValue: string | null = null;
  if ('untilDate' in body) {
    if (body.untilDate <= (await todayIn(client, before.location_id))) {
      throw invalid('Check body.untilDate: a day after today.');
    }
    untilDate = body.untilDate;
  } else if ('untilValue' in body) {
    if (before.meter_id === null)
      throw invalid('Check body.untilValue: this schedule has no meter.');
    untilValue = body.untilValue;
  } else {
    if (before.every_units === null) {
      throw invalid('Send body.untilDate: this schedule counts no units.');
    }
    const { rows } = await client.query<{ v: string }>(
      `SELECT trim_scale(n.due_value + s.every_units / 10)::text AS v
         FROM public.schedules s
         JOIN public.locations l ON l.id = s.location_id
        CROSS JOIN LATERAL kept.schedule_next(s.id, (now() AT TIME ZONE l.timezone)::date) n
        WHERE s.id = $1`,
      [id],
    );
    untilValue = rows[0]?.v ?? null;
  }
  await client.query(
    'UPDATE public.schedules SET snoozed_until = $2, snoozed_until_value = $3 WHERE id = $1',
    [id, untilDate, untilValue],
  );
  await auditSchedule(ctx, 'schedule.snooze', before, await scheduleRow(client, id), true);
  return scheduleView(client, id);
}

/** POST /api/v1/schedules/:id/unsnooze (If-Match) → Schedule. Audited, undoable. */
export async function unsnoozeSchedule(ctx: Ctx, id: string, expected: number): Promise<Schedule> {
  const { client } = ctx;
  const before = await writableSchedule(ctx, id);
  await requireVersion(client, before, expected, ['snoozedUntil']);
  await client.query(
    'UPDATE public.schedules SET snoozed_until = NULL, snoozed_until_value = NULL WHERE id = $1',
    [id],
  );
  await auditSchedule(ctx, 'schedule.unsnooze', before, await scheduleRow(client, id), true);
  return scheduleView(client, id);
}

/**
 * POST /api/v1/schedules/:id/skip (If-Match) → Schedule: "skip once" moves the next due point one
 * interval on without a service (Q28). A one-off has no interval to skip (400). Audited
 * `schedule.skip`, undoable.
 */
export async function skipSchedule(ctx: Ctx, id: string, expected: number): Promise<Schedule> {
  const { client } = ctx;
  const before = await writableSchedule(ctx, id);
  await requireVersion(client, before, expected, ['skipNext']);
  if (before.every_months === null && before.every_units === null) {
    throw invalid('A one-off date has no interval to skip; snooze it or change the date.');
  }
  await client.query('UPDATE public.schedules SET skip_next = true WHERE id = $1', [id]);
  await auditSchedule(ctx, 'schedule.skip', before, await scheduleRow(client, id), true);
  return scheduleView(client, id);
}

/** A schedule's view by id, for the caller (404 when they can't see it or the module is off). */
export async function readSchedule(
  ctx: Pick<Ctx, 'tx' | 'client' | 'scope'>,
  id: string,
): Promise<Schedule> {
  const row = await scheduleRow(ctx.client, id);
  await requireMembership(ctx.client, row.location_id);
  await requireModule(ctx, row.location_id, MODULE, 'read');
  return scheduleView(ctx.client, id);
}

export { scheduleRow };
