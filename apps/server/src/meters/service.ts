import { type Action, isDateFilterValue, newId, type Role } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { assertClientId, checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import type { FileStorage } from '../storage/blob-store.js';
import { requireRole, writableThing } from '../things/service.js';
import {
  dailyLimit,
  decimalOut,
  type Placement,
  placeReading,
  type ReplacementEvent,
  type ReviewReason,
  type SeriesReading,
} from './check.js';
import { type Estimate, estimateOf } from './estimate.js';
import { attachProof, type ProofRef, proofsOf } from './proofs.js';
import { whenDays } from './when.js';

// Meters and readings, core (plan T16; D26, D52, D112, D113, D183; engineering spec §3.4,
// §7.13). Every function runs in the request's scoped kept_app transaction: RLS decides what
// exists (a 404 otherwise), can() what the caller's role may do (a 403), and each write commits
// with its audit row. Meters are core infrastructure (D113), so no module gates these routes.
//
// - A meter and its readings exist only while their thing is live: a trashed thing's meters
//   answer 404 like a missing one.
// - Writes to one meter's series take the meter's row lock, so two readings checked at once
//   can't both pass against a series neither sees the other in.
// - Online entry (D26, D112): a reading that runs backwards against its neighbours in time is
//   refused (409 `conflict`, `reason`, and the neighbour it collides with); one that fits is
//   accepted; one that climbs faster than the daily limit is kept as `needs_review`
//   (`implausible_jump`), and the meter shows it with Keep, Edit and Discard. Readings arriving
//   by sync (step 3) go to the Inbox instead of being refused.
// - `logged_by` and `received_at` are stamped by the database (0024), never taken from here.
// - Step 5 (T8; D26, D27, D52, D150, D195; Q9, Q10, Q11, Q19):
//   - "It's right" (`confirmJump`): online, an implausible jump confirmed at entry is accepted, and
//     its audit says so (`confirmed: 'implausible_jump'`); backwards is never confirmable. A
//     jump arriving by sync still goes to the Inbox.
//   - a typed reading's proof photo (`proofFileId`) hangs on the reading (meters/proofs.ts);
//   - a reading a fill or a service owns (`fuel_entries`/`service_records.meter_reading_id`) is
//     changed through its owner: the readings routes answer 409 `reading_owned` with `ownedBy`.
//     The owner's own writes, and the Inbox's reading actions (the owner follows), pass
//     `{owned: 'allow'}`;
//   - the readings list filters by date, source and state, and carries each proof and owner;
//   - a meter's `nudgeDays` (7–365, or null for none; `meters.manage`) sets the stale-reading
//     nudge, and each meter view carries its usage estimate (meters/estimate.ts);
//   - a reading logged online is undoable for 7 days (`reading.create`, undo/registry.ts), and
//     so is its delete (`reading.delete`, meters/undo.ts).

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  /** For proof thumbnails in a list (step 5); absent, they come without one. */
  files?: FileStorage | null | undefined;
};

const actor = (scope: Scope) => actorOf(scope);

// ---------------------------------------------------------------------------------------------
// Views (apps/web/src/api/inventory/types.ts: ThingMeter, Reading, CreateReadingResult)
// ---------------------------------------------------------------------------------------------

export type MeterView = {
  id: string;
  thingId: string;
  kind: string;
  unit: string;
  label: string | null;
  latest: { value: string; takenAt: string } | null;
  needsReview: number;
  /** Beyond ThingMeter: what PATCH needs (If-Match) and shows. */
  maxPerDay: number | null;
  offset: string;
  rowVersion: number;
  /** Step 5 (Q19): the stale-reading nudge's days, or null for none. */
  nudgeDays: number | null;
  /** Step 5 (Q8): kept.meter_estimate(). */
  estimate: Estimate;
};

export type ReadingView = {
  id: string;
  value: string;
  takenAt: string;
  source: string;
  state: 'accepted' | 'needs_review';
  reviewReason: ReviewReason | null;
  loggedBy: { displayName: string };
  note: string | null;
  /** Beyond the contract's Reading: an If-Match a client may send with PATCH. */
  rowVersion: number;
  /** Step 5: its proof photo (D195), in lists. */
  proof?: ProofRef;
  /** Step 5 (Q11): the fill or service that owns it, which changes it. */
  ownedBy?: ReadingOwner;
};

/** A fill or a service that owns a reading (Q11). */
export type ReadingOwner = { type: 'fuel' | 'service'; id: string };

export type CreateReadingResult = {
  reading: ReadingView;
  state: ReadingView['state'];
  reason?: ReviewReason;
  /** When written undoable (D150): the Undo toast's event. */
  undo?: { eventId: string; until: string };
};

export type MeterRow = {
  id: string;
  location_id: string;
  thing_id: string;
  kind: string;
  unit: string;
  label: string | null;
  offset: string;
  max_per_day: string | null;
  row_version: number;
  nudge_days: number | null;
};

const METER_SELECT = `SELECT m.id, m.location_id, m.thing_id, m.kind, m.unit, m.label,
       trim_scale(m."offset")::text AS "offset", trim_scale(m.max_per_day)::text AS max_per_day,
       m.row_version, m.nudge_days
  FROM public.meters m
  JOIN public.things t ON t.id = m.thing_id AND t.deleted_at IS NULL`;

async function meterView(client: pg.ClientBase, id: string): Promise<MeterView> {
  const m = await liveMeter(client, id);
  const { rows } = await client.query<{
    value: string | null;
    taken_at: Date | null;
    needs_review: number;
  }>(
    `SELECT l.value, l.taken_at,
            (SELECT count(*)::int FROM public.meter_readings r
              WHERE r.meter_id = $1 AND r.state = 'needs_review') AS needs_review
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT trim_scale(r.value)::text AS value, r.taken_at FROM public.meter_readings r
          WHERE r.meter_id = $1 AND r.state = 'accepted'
          ORDER BY r.taken_at DESC, r.id DESC LIMIT 1) l ON true`,
    [id],
  );
  const s = rows[0];
  return {
    id: m.id,
    thingId: m.thing_id,
    kind: m.kind,
    unit: m.unit,
    label: m.label,
    latest:
      s?.value != null && s.taken_at ? { value: s.value, takenAt: s.taken_at.toISOString() } : null,
    needsReview: s?.needs_review ?? 0,
    maxPerDay: m.max_per_day === null ? null : Number(m.max_per_day),
    offset: m.offset,
    rowVersion: m.row_version,
    nudgeDays: m.nudge_days,
    estimate: await estimateOf(client, m.id),
  };
}

type ReadingRow = {
  id: string;
  meter_id: string;
  value: string;
  taken_at: Date;
  source: string;
  state: 'accepted' | 'needs_review';
  review_reason: ReviewReason | null;
  note: string | null;
  logged_by: string | null;
  logged_by_name: string | null;
  row_version: number;
};

const READING_SELECT = `SELECT r.id, r.meter_id, trim_scale(r.value)::text AS value, r.taken_at,
       r.source, r.state, r.review_reason, r.note, r.logged_by,
       up.display_name AS logged_by_name, r.row_version
  FROM public.meter_readings r
  LEFT JOIN public.user_profiles up ON up.user_id = r.logged_by`;

const readingOf = (r: ReadingRow): ReadingView => ({
  id: r.id,
  value: r.value,
  takenAt: r.taken_at.toISOString(),
  source: r.source,
  state: r.state,
  reviewReason: r.review_reason,
  loggedBy: { displayName: r.logged_by_name ?? '' },
  note: r.note,
  rowVersion: r.row_version,
});

/** The audit image of a reading (snake_case, as audited() stores it). */
const readingImage = (r: ReadingRow) => ({
  meter_id: r.meter_id,
  value: r.value,
  taken_at: r.taken_at,
  source: r.source,
  state: r.state,
  review_reason: r.review_reason,
  note: r.note,
});

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** A meter of a live thing the caller can see. */
async function liveMeter(client: pg.ClientBase, id: string): Promise<MeterRow> {
  const { rows } = await client.query<MeterRow>(`${METER_SELECT} WHERE m.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Locks a meter's series for this transaction (after the role check: under RLS a viewer's
 * `FOR UPDATE` finds nothing, which would turn their 403 into a 404). */
async function lockMeter(client: pg.ClientBase, id: string): Promise<MeterRow> {
  await client.query('SELECT 1 FROM public.meters WHERE id = $1 FOR UPDATE', [id]);
  return liveMeter(client, id);
}

async function writableMeter(
  client: pg.ClientBase,
  id: string,
  action: Action,
): Promise<MeterRow & { role: Role }> {
  const seen = await liveMeter(client, id);
  const role = await requireRole(client, seen.location_id, action);
  return { ...(await lockMeter(client, id)), role };
}

async function readingRow(client: pg.ClientBase, id: string): Promise<ReadingRow> {
  const { rows } = await client.query<ReadingRow>(`${READING_SELECT} WHERE r.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * A reading the caller may change, with its meter locked: 404 when they can't see it (or its
 * thing is trashed), 403 unless their role may change it. Their own: `logs.edit-own`; anyone
 * else's: `logs.edit-delete-others` (product design §7.1).
 */
async function changeableReading(
  client: pg.ClientBase,
  scope: Scope,
  id: string,
): Promise<{ reading: ReadingRow; meter: MeterRow }> {
  const seen = await readingRow(client, id);
  const meter = await liveMeter(client, seen.meter_id);
  const mine = seen.logged_by === scope.userId;
  await requireRole(client, meter.location_id, mine ? 'logs.edit-own' : 'logs.edit-delete-others');
  const locked = await lockMeter(client, meter.id);
  return { reading: await readingRow(client, id), meter: locked };
}

/** The meter's replacement events, for the offsets (D52). */
async function replacements(client: pg.ClientBase, meterId: string): Promise<ReplacementEvent[]> {
  const { rows } = await client.query<{ at: Date; offset: string }>(
    `SELECT at, "offset"::text AS "offset" FROM public.meter_events
      WHERE meter_id = $1 AND kind = 'replaced' ORDER BY at, id`,
    [meterId],
  );
  return rows;
}

/** The accepted readings just before and just after `takenAt` (the only ones placeReading()
 * compares against), leaving out `except`. */
async function neighbours(
  client: pg.ClientBase,
  meterId: string,
  takenAt: Date,
  except: string | null,
): Promise<SeriesReading[]> {
  const { rows } = await client.query<{ id: string; value: string; taken_at: Date }>(
    `(SELECT id, value::text AS value, taken_at FROM public.meter_readings
       WHERE meter_id = $1 AND state = 'accepted' AND taken_at <= $2
         AND ($3::uuid IS NULL OR id <> $3)
       ORDER BY taken_at DESC, id DESC LIMIT 1)
     UNION ALL
     (SELECT id, value::text AS value, taken_at FROM public.meter_readings
       WHERE meter_id = $1 AND state = 'accepted' AND taken_at > $2
         AND ($3::uuid IS NULL OR id <> $3)
       ORDER BY taken_at, id LIMIT 1)`,
    [meterId, takenAt, except],
  );
  return rows.map((r) => ({ id: r.id, value: r.value, takenAt: r.taken_at }));
}

/** Where a value taken at `takenAt` falls in the meter's series. */
async function placement(
  client: pg.ClientBase,
  meter: MeterRow,
  value: string,
  takenAt: Date,
  except: string | null,
): Promise<Placement> {
  // In turn: both read on the one client, which runs one query at a time.
  const series = await neighbours(client, meter.id, takenAt, except);
  const events = await replacements(client, meter.id);
  const limit = dailyLimit({ kind: meter.kind, unit: meter.unit, maxPerDay: meter.max_per_day });
  return placeReading({ value, takenAt }, series, events, limit);
}

/**
 * Where `value`, taken at `takenAt`, would fall in a live meter's series, with the meter; null when
 * the caller can't see it or its thing is trashed. For a reading AI read (step-3 T10), which is
 * never applied: it waits for review with this verdict (D19, D112).
 */
export async function placementOf(
  client: pg.ClientBase,
  meterId: string,
  value: string,
  takenAt: Date,
): Promise<{ meter: MeterRow; placement: Placement } | null> {
  const { rows } = await client.query<MeterRow>(`${METER_SELECT} WHERE m.id = $1`, [meterId]);
  const meter = rows[0];
  if (!meter) return null;
  return { meter, placement: await placement(client, meter, value, takenAt, null) };
}

/**
 * Online entry refuses a backwards reading (D26), naming the neighbour it collides with so the
 * person can check the value, or record the meter's replacement first (D52).
 */
function refuseBackwards(meter: MeterRow, p: Placement): void {
  if (p.reason === 'lower_than_previous' && p.previous) {
    throw new AppError(
      'conflict',
      409,
      `Lower than the reading before it (${decimalOut(p.previous.value)} ${meter.unit}). ` +
        'Check the value, or record that the meter was replaced first.',
      {
        reason: p.reason,
        previous: {
          value: decimalOut(p.previous.value),
          takenAt: p.previous.takenAt.toISOString(),
        },
      },
    );
  }
  if (p.reason === 'higher_than_next' && p.next) {
    throw new AppError(
      'conflict',
      409,
      `Higher than the reading after it (${decimalOut(p.next.value)} ${meter.unit}). ` +
        'Check the value and the date it was taken.',
      {
        reason: p.reason,
        next: { value: decimalOut(p.next.value), takenAt: p.next.takenAt.toISOString() },
      },
    );
  }
}

/** D112: a reading is never taken later than the server received it. */
const clampToNow = (at: Date, now = new Date()) => (at.getTime() > now.getTime() ? now : at);

// ---------------------------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------------------------

export type CreateMeterInput = {
  kind: 'distance' | 'hours' | 'custom';
  unit: string;
  label?: string | undefined;
  maxPerDay?: number | undefined;
};

/** POST /api/v1/things/:id/meters (`meters.manage`) → 201 MeterView. */
export async function createMeter(
  ctx: Ctx,
  thingId: string,
  body: CreateMeterInput,
): Promise<MeterView> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, thingId, 'meters.manage');
  // D10: the guard would say so too (things_quantity_one), less helpfully.
  if (Number(thing.quantity) !== 1) {
    throw conflict('Only a single thing can have a meter: split it so its quantity is 1 first.');
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.meters (location_id, thing_id, kind, unit, label, max_per_day)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [thing.location_id, thingId, body.kind, body.unit, body.label ?? null, body.maxPerDay ?? null],
  );
  const id = (rows[0] as { id: string }).id;
  const view = await meterView(client, id);
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'meter.create',
    entity: { type: 'meter', id },
    after: {
      thing_id: thingId,
      kind: view.kind,
      unit: view.unit,
      label: view.label,
      max_per_day: view.maxPerDay,
    },
    rootThingId: thingId,
    requestId: ctx.requestId,
  });
  return view;
}

export type UpdateMeterInput = {
  label?: string | null | undefined;
  maxPerDay?: number | null | undefined;
  /** Step 5 (Q19): 7–365 days, or null for no nudge. */
  nudgeDays?: number | null | undefined;
};

/** PATCH /api/v1/meters/:id (If-Match, `meters.manage`) → MeterView; 412 per D156. */
export async function updateMeter(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateMeterInput,
): Promise<MeterView> {
  const { client, tx, scope } = ctx;
  const meter = await writableMeter(client, id, 'meters.manage');
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdateMeterInput] !== undefined);
  if (meter.row_version !== expected) {
    const name = await lastChangedBy(client, meter.location_id, { type: 'meter', id });
    checkVersion(
      { rowVersion: meter.row_version },
      expected,
      fields,
      name ? { displayName: name } : null,
    );
  }
  const before = await meterView(client, id);
  if (fields.length === 0) return before;
  await client.query(
    `UPDATE public.meters
        SET label = CASE WHEN $2 THEN $3 ELSE label END,
            max_per_day = CASE WHEN $4 THEN $5::numeric ELSE max_per_day END,
            nudge_days = CASE WHEN $6 THEN $7::integer ELSE nudge_days END
      WHERE id = $1`,
    [
      id,
      body.label !== undefined,
      body.label ?? null,
      body.maxPerDay !== undefined,
      body.maxPerDay ?? null,
      body.nudgeDays !== undefined,
      body.nudgeDays ?? null,
    ],
  );
  const after = await meterView(client, id);
  await audited(tx, {
    locationId: meter.location_id,
    actor: actor(scope),
    action: 'meter.update',
    entity: { type: 'meter', id },
    before: { label: before.label, max_per_day: before.maxPerDay, nudge_days: before.nudgeDays },
    after: { label: after.label, max_per_day: after.maxPerDay, nudge_days: after.nudgeDays },
    rootThingId: meter.thing_id,
    requestId: ctx.requestId,
  });
  return after;
}

export type ReplacedResult = {
  event: { id: string; at: string; offset: string };
  meter: MeterView;
};

/**
 * POST /api/v1/meters/:id/replaced (D52, `meters.manage`) → 201: the meter was replaced at `at`,
 * and from then on its readings count from `offset`. The meter's own `offset` is the one in force
 * now (the latest replacement's). An If-Match, when sent, is checked against the meter.
 */
export async function recordReplacement(
  ctx: Ctx,
  id: string,
  body: { at: string; offset: string },
  expected: number | null,
): Promise<ReplacedResult> {
  const { client, tx, scope } = ctx;
  const meter = await writableMeter(client, id, 'meters.manage');
  if (expected !== null && meter.row_version !== expected) {
    const name = await lastChangedBy(client, meter.location_id, { type: 'meter', id });
    checkVersion(
      { rowVersion: meter.row_version },
      expected,
      ['offset'],
      name ? { displayName: name } : null,
    );
  }
  const at = clampToNow(new Date(body.at));
  const { rows } = await client.query<{ id: string; offset: string }>(
    `INSERT INTO public.meter_events (location_id, meter_id, kind, at, "offset")
     VALUES ($1, $2, 'replaced', $3, $4) RETURNING id, trim_scale("offset")::text AS "offset"`,
    [meter.location_id, id, at, body.offset],
  );
  const event = rows[0] as { id: string; offset: string };
  await client.query(
    `UPDATE public.meters m
        SET "offset" = (SELECT e."offset" FROM public.meter_events e
                         WHERE e.meter_id = m.id AND e.kind = 'replaced'
                         ORDER BY e.at DESC, e.id DESC LIMIT 1)
      WHERE m.id = $1`,
    [id],
  );
  const view = await meterView(client, id);
  await audited(tx, {
    locationId: meter.location_id,
    actor: actor(scope),
    action: 'meter.replaced',
    entity: { type: 'meter', id },
    before: { offset: meter.offset },
    after: { offset: view.offset, replaced_at: at, replacement_offset: event.offset },
    rootThingId: meter.thing_id,
    requestId: ctx.requestId,
  });
  return { event: { id: event.id, at: at.toISOString(), offset: event.offset }, meter: view };
}

// ---------------------------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------------------------

const ReadingCursor = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);

/** GET /api/v1/meters/:id/readings: the `readings` surface's filters (step 5, T8; D205). */
export type ReadingListQuery = {
  limit: number;
  cursor?: string | undefined;
  'f.when'?: string | undefined;
  'f.source'?: string[] | undefined;
  'f.state'?: ('accepted' | 'needs_review')[] | undefined;
  not?: ('when' | 'source' | 'state')[] | undefined;
  sort?: 'takenAt' | undefined;
  dir?: 'asc' | 'desc' | undefined;
};

/**
 * GET /api/v1/meters/:id/readings → by when they were taken, newest first unless `dir=asc`,
 * `{items, next_cursor}`; each with its proof photo and its owner (a fill or a service, Q11).
 * `f.when` is in the location's days.
 */
export async function listReadings(
  ctx: Pick<Ctx, 'client' | 'files'>,
  meterId: string,
  page: ReadingListQuery,
): Promise<{ items: ReadingView[]; next_cursor: string | null }> {
  const { client } = ctx;
  const meter = await liveMeter(client, meterId);
  let after: [string, string] | null = null;
  if (page.cursor) {
    // Only a cursor this route made: [taken_at, id]. Anything else is a 400 (review #36), not a
    // cast error and not a silent first page.
    const parsed = ReadingCursor.safeParse(decodeCursor(page.cursor));
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    after = parsed.data;
  }
  const args: unknown[] = [meterId];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  const not = new Set<string>(page.not ?? []);
  const where = ['r.meter_id = $1'];
  const filter = (name: string, cond: string) =>
    where.push(not.has(name) ? `NOT coalesce(${cond}, false)` : cond);
  const when = page['f.when'];
  if (when) {
    if (!isDateFilterValue(when)) {
      throw invalid('f.when is today, week, month, year or YYYY-MM-DD..YYYY-MM-DD.');
    }
    const { rows: tz } = await client.query<{ timezone: string; today: string }>(
      `SELECT timezone, (now() AT TIME ZONE timezone)::date::text AS today
         FROM public.locations WHERE id = $1`,
      [meter.location_id],
    );
    const zone = tz[0]?.timezone ?? 'UTC';
    const { from, to } = whenDays(when, tz[0]?.today ?? new Date().toISOString().slice(0, 10));
    const z = arg(zone);
    const parts = [
      ...(from ? [`r.taken_at >= (${arg(from)}::date::timestamp AT TIME ZONE ${z})`] : []),
      ...(to ? [`r.taken_at < ((${arg(to)}::date + 1)::timestamp AT TIME ZONE ${z})`] : []),
    ];
    if (parts.length > 0) filter('when', `(${parts.join(' AND ')})`);
  }
  if (page['f.source']?.length) filter('source', `r.source = ANY (${arg(page['f.source'])})`);
  if (page['f.state']?.length) filter('state', `r.state = ANY (${arg(page['f.state'])})`);
  const asc = page.dir === 'asc';
  if (after) {
    where.push(
      `(r.taken_at, r.id) ${asc ? '>' : '<'} (${arg(after[0])}::timestamptz, ${arg(after[1])}::uuid)`,
    );
  }
  const dir = asc ? 'ASC' : 'DESC';
  const { rows } = await client.query<ReadingRow>(
    `${READING_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY r.taken_at ${dir}, r.id ${dir}
      LIMIT ${arg(page.limit + 1)}`,
    args,
  );
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  const ids = items.map((r) => r.id);
  // In turn: both read on the one client, which runs one query at a time.
  const proofs = await proofsOf(client, ctx.files ?? null, ids);
  const owners = await ownersOf(client, ids);
  return {
    items: items.map((r) => {
      const proof = proofs.get(r.id);
      const owner = owners.get(r.id);
      return { ...readingOf(r), ...(proof ? { proof } : {}), ...(owner ? { ownedBy: owner } : {}) };
    }),
    next_cursor:
      rows.length > page.limit && last
        ? encodeCursor([last.taken_at.toISOString(), last.id])
        : null,
  };
}

/** The fill or service owning each reading (Q11), read as the caller: an owner lives in its
 * reading's location (their composite keys), which the caller sees when they see the reading. */
export async function ownersOf(
  client: pg.ClientBase,
  readingIds: readonly string[],
): Promise<Map<string, ReadingOwner>> {
  const out = new Map<string, ReadingOwner>();
  if (readingIds.length === 0) return out;
  const { rows } = await client.query<{ reading_id: string; type: 'fuel' | 'service'; id: string }>(
    `SELECT f.meter_reading_id AS reading_id, 'fuel' AS type, f.id
       FROM public.fuel_entries f WHERE f.meter_reading_id = ANY ($1::uuid[])
     UNION ALL
     SELECT s.meter_reading_id, 'service', s.id
       FROM public.service_records s WHERE s.meter_reading_id = ANY ($1::uuid[])`,
    [[...readingIds]],
  );
  for (const r of rows) out.set(r.reading_id, { type: r.type, id: r.id });
  return out;
}

/** 409 `reading_owned` (Q11): a fill's or a service's reading is changed through its owner. */
async function refuseOwned(client: pg.ClientBase, readingId: string): Promise<void> {
  const owner = (await ownersOf(client, [readingId])).get(readingId);
  if (owner) {
    throw new AppError(
      'reading_owned',
      409,
      owner.type === 'fuel'
        ? 'Change this reading from its fuel entry.'
        : 'Change this reading from its service record.',
      { ownedBy: owner },
    );
  }
}

/** Whether a write may change a reading someone else owns: `allow` for the owner's own writes
 * (a service's edit) and the Inbox's reading actions, whose owner follows (Q11). */
export type OwnedOption = { owned?: 'refuse' | 'allow' };

export type CreateReadingInput = {
  id?: string | undefined;
  value: string;
  takenAt: string;
  note?: string | undefined;
  /** Step 5 (Q9): "It's right": an implausible jump is stored accepted. Online only. */
  confirmJump?: true | undefined;
  /** Step 5 (Q10, D195): the photo that proves it, hung on the reading. */
  proofFileId?: string | undefined;
};

export type CreateReadingOptions = {
  /** `op`: the `log_reading` sync op (step-3 T14), which checked the client id against its own
   * 90-day window, and whose misfit is never refused: a reading that runs backwards is kept as
   * `needs_review` with its reason, for the Inbox (D112: never silently rejected). */
  via?: 'online' | 'op';
  /** The reading can be undone for 7 days (a tool's write, step-6 T9, D124): undo removes it,
   * unless it changed since. */
  undoable?: boolean;
};

/** POST /api/v1/meters/:id/readings (`logs.add`) → 201 {reading, state, reason?}; 409 when the
 * reading runs backwards (D26). */
export async function createReading(
  ctx: Ctx,
  meterId: string,
  body: CreateReadingInput,
  /** `photo` for a READING capture's typed value (capture/service.ts, T13; §1.6); `fuel` for a
   * fill's odometer (fuel/service.ts, T11). 0017's meter_readings_source_chk accepts all three. */
  source: 'manual' | 'photo' | 'fuel' = 'manual',
  opts: CreateReadingOptions = {},
): Promise<CreateReadingResult> {
  const { client, tx, scope } = ctx;
  const byOp = opts.via === 'op';
  const id = body.id ? (byOp ? body.id.toLowerCase() : assertClientId(body.id)) : null;
  const meter = await writableMeter(client, meterId, 'logs.add');
  const takenAt = clampToNow(new Date(body.takenAt));
  const p = await placement(client, meter, body.value, takenAt, null);
  if (!byOp) refuseBackwards(meter, p);
  // Online, only a jump is left to review here (backwards was refused above), unless the person
  // says it's right (Q9); by op, any misfit.
  const confirmed = !byOp && body.confirmJump === true && p.reason === 'implausible_jump';
  const review = p.reason !== null && !confirmed;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.meter_readings
       (id, location_id, meter_id, value, taken_at, source, state, review_reason, note)
     VALUES ($1, $2, $3, $4, $5, $9, $6, $7, $8) RETURNING id`,
    [
      id ?? newId(),
      meter.location_id,
      meterId,
      body.value,
      takenAt,
      review ? 'needs_review' : 'accepted',
      review ? p.reason : null,
      body.note ?? null,
      source,
    ],
  );
  const row = await readingRow(client, (rows[0] as { id: string }).id);
  const proofId = body.proofFileId
    ? await attachProof(client, meter.location_id, row.id, body.proofFileId)
    : null;
  const until = opts.undoable ? undoableUntil() : null;
  const event = await audited(tx, {
    locationId: meter.location_id,
    actor: actor(scope),
    action: 'reading.create',
    entity: { type: 'meter_reading', id: row.id },
    after: {
      ...readingImage(row),
      ...(confirmed ? { confirmed: 'implausible_jump' } : {}),
      ...(proofId ? { proof_attachment_id: proofId } : {}),
    },
    rootThingId: meter.thing_id,
    requestId: ctx.requestId,
    ...(until ? { undoableUntil: until } : {}),
  });
  const reading = readingOf(row);
  return {
    reading,
    state: reading.state,
    ...(reading.reviewReason ? { reason: reading.reviewReason } : {}),
    ...(until ? { undo: { eventId: event.id, until: until.toISOString() } } : {}),
  };
}

export type UpdateReadingInput = {
  value?: string | undefined;
  takenAt?: string | undefined;
  note?: string | null | undefined;
};

/**
 * PATCH /api/v1/readings/:id → Reading. A new value or time is placed again (D112): backwards is
 * refused, a jump waits for review, and one that now fits is accepted (the needs-review "Edit").
 * A note alone leaves the state as it is, so editing the note of a kept jump doesn't un-keep it.
 * If-Match is optional (the web sends none); when sent, a stale one is 412.
 */
export async function updateReading(
  ctx: Ctx,
  id: string,
  body: UpdateReadingInput,
  expected: number | null,
  opts: OwnedOption = {},
): Promise<ReadingView> {
  const { client, tx, scope } = ctx;
  const { reading, meter } = await changeableReading(client, scope, id);
  if (opts.owned !== 'allow') await refuseOwned(client, id);
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdateReadingInput] !== undefined);
  if (expected !== null && reading.row_version !== expected) {
    const name = await lastChangedBy(client, meter.location_id, { type: 'meter_reading', id });
    checkVersion(
      { rowVersion: reading.row_version },
      expected,
      fields,
      name ? { displayName: name } : null,
    );
  }
  if (fields.length === 0) return readingOf(reading);
  const value = body.value ?? reading.value;
  const takenAt =
    body.takenAt !== undefined ? clampToNow(new Date(body.takenAt)) : reading.taken_at;
  let state = reading.state;
  let reason = reading.review_reason;
  if (body.value !== undefined || body.takenAt !== undefined) {
    const p = await placement(client, meter, value, takenAt, id);
    refuseBackwards(meter, p);
    state = p.reason ? 'needs_review' : 'accepted';
    reason = p.reason;
  }
  await client.query(
    `UPDATE public.meter_readings
        SET value = $2, taken_at = $3, state = $4, review_reason = $5,
            note = CASE WHEN $6 THEN $7 ELSE note END
      WHERE id = $1`,
    [id, value, takenAt, state, reason, body.note !== undefined, body.note ?? null],
  );
  const after = await readingRow(client, id);
  await audited(tx, {
    locationId: meter.location_id,
    actor: actor(scope),
    action: 'reading.update',
    entity: { type: 'meter_reading', id },
    before: readingImage(reading),
    after: readingImage(after),
    rootThingId: meter.thing_id,
    requestId: ctx.requestId,
  });
  return readingOf(after);
}

/** POST /api/v1/readings/:id/accept: "Keep" a reading that waits for review (D112) → Reading.
 * Keeping one already accepted changes nothing. */
export async function acceptReading(ctx: Ctx, id: string): Promise<ReadingView> {
  const { client, tx, scope } = ctx;
  const { reading, meter } = await changeableReading(client, scope, id);
  if (reading.state === 'accepted') return readingOf(reading);
  await client.query(
    `UPDATE public.meter_readings SET state = 'accepted', review_reason = NULL WHERE id = $1`,
    [id],
  );
  const after = await readingRow(client, id);
  await audited(tx, {
    locationId: meter.location_id,
    actor: actor(scope),
    action: 'reading.accept',
    entity: { type: 'meter_reading', id },
    before: readingImage(reading),
    after: readingImage(after),
    rootThingId: meter.thing_id,
    requestId: ctx.requestId,
  });
  return readingOf(after);
}

/**
 * DELETE /api/v1/readings/:id → 204 ("Discard", or removing a mistake). The route's is undoable
 * for 7 days (D150, meters/undo.ts): the reading comes back with its id, placed again, and its
 * proof photos with it. An owned reading is refused (409 `reading_owned`) unless `owned: 'allow'`.
 */
export async function deleteReading(
  ctx: Ctx,
  id: string,
  opts: OwnedOption & { undoable?: boolean } = {},
): Promise<void> {
  const { client, tx, scope } = ctx;
  const { reading, meter } = await changeableReading(client, scope, id);
  if (opts.owned !== 'allow') await refuseOwned(client, id);
  const { rows: proofs } = await client.query<{ id: string; file_id: string; sort: number }>(
    `SELECT id, file_id, sort FROM public.attachments
      WHERE meter_reading_id = $1 AND file_id IS NOT NULL ORDER BY sort, id`,
    [id],
  );
  await client.query('DELETE FROM public.meter_readings WHERE id = $1', [id]);
  await audited(tx, {
    locationId: meter.location_id,
    actor: actor(scope),
    action: 'reading.delete',
    entity: { type: 'meter_reading', id },
    before: { ...readingImage(reading), proofs },
    after: null,
    rootThingId: meter.thing_id,
    requestId: ctx.requestId,
    ...(opts.undoable ? { undoableUntil: undoableUntil() } : {}),
  });
}
