import type pg from 'pg';
import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { conflict } from '../http/errors.js';
import { gateFor } from '../serialize/gates.js';
import { moneyOff } from '../things/validate.js';
import { scheduleRow } from './service.js';
import { type ServiceImage, serviceImage, serviceRow } from './services.js';
import { type ScheduleRow, scheduleImage } from './view.js';

// Undo for schedules and service records (plan T11; D150, D124; Q25, Q28). Each handler checks
// that what the event changed is still as the event left it (else 409 `undo_refused`
// `changed_since`, naming who), puts the before-image back, and writes its own audit row.
//
// - schedule.update, .snooze, .skip, .unsnooze: the changed columns go back (the anchor follows
//   its base, 0053).
// - schedule.delete: the row comes back with its id, and the services that completed it complete
//   it again (then its snooze and skip, which a new completion clears, are put back as they were).
// - service_record.create (a completion): the record goes, with the reading it made; the
//   schedules' anchors fall back (0053) and their snooze and skip come back.
// - service_record.update: the record, its lines, completions and reading go back.
// - service_record.delete: the record comes back with its id, lines, completions and files (a
//   file already purged, a day after it lost its last attachment, stays gone).
// A re-inserted row is written by the person undoing (the insert policies say so, 0051, 0053):
// they made the change being undone, or they are an owner or admin there.

type Diff = UndoArgs['event']['diff'];
const beforeOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.before ?? null]));
const afterOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.after ?? null]));

async function refuse(args: UndoArgs, type: string, id: string, fields: string[]): Promise<never> {
  const who = await lastChangedBy(args.client, args.event.locationId, { type, id }, args.event.at);
  throw undoConflict(fields, who);
}

/** 409 `module_off` when the undo writes money the caller can't see. */
async function requireMoney(args: UndoArgs, diff: Diff): Promise<void> {
  const touches = Object.entries(diff).some(([, c]) => c.class === 'money');
  if (touches && !(await gateFor(args.tx, args.event.locationId, args.scope)).showMoney) {
    throw moneyOff();
  }
}

// ---------------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------------

/** The columns a schedule's image names (all writable by kept_app). */
const SCHEDULE_FIELDS = [
  'name',
  'every_months',
  'every_units',
  'meter_id',
  'due_on',
  'lead_days',
  'lead_units',
  'base_on',
  'base_value',
  'snoozed_until',
  'snoozed_until_value',
  'skip_next',
  'active',
] as const;

async function lockedSchedule(args: UndoArgs, id: string): Promise<ScheduleRow> {
  try {
    const row = await scheduleRow(args.client, id, true);
    if (row.location_id !== args.event.locationId) throw conflict();
    return row;
  } catch {
    throw conflict("Can't undo: that schedule no longer exists.");
  }
}

/** schedule.update, .snooze, .skip, .unsnooze: the changed columns go back. */
async function undoScheduleFields(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'schedule' || !id) throw notUndoable();
  const row = await lockedSchedule(args, id);
  const fields = Object.keys(event.diff);
  if (fields.some((f) => !(SCHEDULE_FIELDS as readonly string[]).includes(f))) throw notUndoable();
  const current = scheduleImage(row) as Record<string, unknown>;
  const conflicts = changedSince(event.diff, current);
  if (conflicts.length > 0) await refuse(args, 'schedule', id, conflicts);
  const back = beforeOf(event.diff);
  await client.query(
    `UPDATE public.schedules SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...fields.map((f) => back[f])],
  );
  const after = await scheduleRow(client, id);
  await args.audit({
    action: event.action,
    entity: { type: 'schedule', id },
    before: scheduleImage(row),
    after: scheduleImage(after),
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
  });
}

/** Completions put back; then the snooze and skip a new completion clears (0053, Q28). */
async function recomplete(
  client: pg.ClientBase,
  locationId: string,
  scheduleId: string,
  recordIds: readonly string[],
  keep: { snoozed_until: unknown; snoozed_until_value: unknown; skip_next: unknown },
): Promise<void> {
  for (const recordId of recordIds) {
    await client.query(
      `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
       SELECT $1, r.id, $3 FROM public.service_records r WHERE r.id = $2
       ON CONFLICT DO NOTHING`,
      [locationId, recordId, scheduleId],
    );
  }
  await client.query(
    `UPDATE public.schedules
        SET snoozed_until = $2, snoozed_until_value = $3, skip_next = $4
      WHERE id = $1`,
    [scheduleId, keep.snoozed_until, keep.snoozed_until_value, keep.skip_next ?? false],
  );
}

/** schedule.delete: the row comes back, with its id. */
async function undoScheduleDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'schedule' || !id) throw notUndoable();
  const b = beforeOf(event.diff);
  const { rowCount: exists } = await client.query('SELECT 1 FROM public.schedules WHERE id = $1', [
    id,
  ]);
  if (exists) throw conflict("Can't undo: that schedule is back already.");
  const subject = b.thing_id
    ? await client.query('SELECT 1 FROM public.things WHERE id = $1 AND deleted_at IS NULL', [
        b.thing_id,
      ])
    : await client.query('SELECT 1 FROM public.places WHERE id = $1 AND deleted_at IS NULL', [
        b.place_id,
      ]);
  if (!subject.rowCount) throw conflict("Can't undo: what the schedule was for is gone.");
  await client.query(
    `INSERT INTO public.schedules (id, location_id, thing_id, place_id, name, every_months,
                                   every_units, meter_id, due_on, lead_days, lead_units, base_on,
                                   base_value, anchor_on, anchor_value, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $12, $13, $14,
             kept.current_user_id())`,
    [
      id,
      event.locationId,
      b.thing_id,
      b.place_id,
      b.name,
      b.every_months,
      b.every_units,
      b.meter_id,
      b.due_on,
      b.lead_days,
      b.lead_units,
      b.base_on,
      b.base_value,
      b.active ?? true,
    ],
  );
  await recomplete(client, event.locationId, id, (b.completed_by as string[] | null) ?? [], {
    snoozed_until: b.snoozed_until,
    snoozed_until_value: b.snoozed_until_value,
    skip_next: b.skip_next,
  });
  const row = await scheduleRow(client, id);
  await args.audit({
    action: 'schedule.delete',
    entity: { type: 'schedule', id },
    before: null,
    after: scheduleImage(row),
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
  });
}

// ---------------------------------------------------------------------------------------------
// Service records
// ---------------------------------------------------------------------------------------------

type Cleared = {
  id: string;
  snoozed_until: string | null;
  snoozed_until_value: string | null;
  skip_next: boolean;
};

/** The image fields an undo compares (what the event left); `reading_created` is the event's. */
const comparable = (image: Record<string, unknown>) => {
  const { reading_created: _r, cleared_schedules: _c, attachments: _a, ...rest } = image;
  return rest;
};

async function lockedService(args: UndoArgs, id: string) {
  try {
    const row = await serviceRow(args.client, id, true);
    if (row.location_id !== args.event.locationId) throw conflict();
    return row;
  } catch {
    throw conflict("Can't undo: that service no longer exists.");
  }
}

/** Deletes a reading the undone write made, unless another service has come to use it. */
async function dropReading(client: pg.ClientBase, readingId: unknown): Promise<void> {
  if (typeof readingId !== 'string') return;
  await client.query(
    `DELETE FROM public.meter_readings d WHERE d.id = $1
        AND NOT EXISTS (SELECT 1 FROM public.service_records r WHERE r.meter_reading_id = d.id)`,
    [readingId],
  );
}

/** service_record.create (a completion): the record and its reading go; snooze and skip return. */
async function undoServiceCreate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'service_record' || !id) throw notUndoable();
  const row = await lockedService(args, id);
  const image = (await serviceImage(client, row)) as unknown as Record<string, unknown>;
  const conflicts = changedSince(
    Object.fromEntries(Object.entries(event.diff).filter(([f]) => f in comparable(image))),
    image,
  );
  if (conflicts.length > 0) await refuse(args, 'service_record', id, conflicts);
  const after = afterOf(event.diff);
  await client.query('DELETE FROM public.service_records WHERE id = $1', [id]);
  if (after.reading_created === true) await dropReading(client, after.meter_reading_id);
  const cleared = (beforeOf(event.diff).cleared_schedules as Cleared[] | null) ?? [];
  for (const c of cleared) {
    await client.query(
      `UPDATE public.schedules
          SET snoozed_until = $2, snoozed_until_value = $3, skip_next = $4
        WHERE id = $1`,
      [c.id, c.snoozed_until, c.snoozed_until_value, c.skip_next],
    );
  }
  await args.audit({
    action: event.action,
    entity: { type: 'service_record', id },
    before: comparable(image),
    after: null,
    fieldClasses: { total: 'money', lines: 'money' },
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
  });
}

/** Puts a record's lines and completions back to an image's (snooze and skip kept). */
async function restoreChildren(
  client: pg.ClientBase,
  locationId: string,
  id: string,
  image: Pick<ServiceImage, 'lines' | 'completes'>,
): Promise<void> {
  await client.query('DELETE FROM public.service_lines WHERE service_record_id = $1', [id]);
  for (const l of image.lines ?? []) {
    await client.query(
      `INSERT INTO public.service_lines (id, location_id, service_record_id, kind, description,
                                         quantity, unit_cost, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [l.id, locationId, id, l.kind, l.description, l.quantity, l.unit_cost, l.sort],
    );
  }
  const want = image.completes ?? [];
  await client.query(
    `DELETE FROM public.service_completions
      WHERE service_record_id = $1 AND NOT (schedule_id = ANY ($2::uuid[]))`,
    [id, want],
  );
  for (const scheduleId of want) {
    const { rows } = await client.query<Cleared>(
      `SELECT id, snoozed_until::text AS snoozed_until,
              trim_scale(snoozed_until_value)::text AS snoozed_until_value, skip_next
         FROM public.schedules WHERE id = $1`,
      [scheduleId],
    );
    const keep = rows[0];
    if (!keep) continue;
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.service_completions WHERE service_record_id = $1 AND schedule_id = $2',
      [id, scheduleId],
    );
    if (rowCount) continue;
    await recomplete(client, locationId, scheduleId, [id], keep);
  }
}

/** service_record.update: the record, its lines, completions and reading go back. */
async function undoServiceUpdate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'service_record' || !id) throw notUndoable();
  await requireMoney(args, event.diff);
  const row = await lockedService(args, id);
  const image = (await serviceImage(client, row)) as unknown as Record<string, unknown>;
  const diff = Object.fromEntries(
    Object.entries(event.diff).filter(([f]) => f !== 'reading_created'),
  );
  const conflicts = changedSince(diff, image);
  if (conflicts.length > 0) await refuse(args, 'service_record', id, conflicts);
  const back = { ...image, ...beforeOf(diff) } as unknown as ServiceImage;
  const after = afterOf(event.diff);
  await client.query(
    `UPDATE public.service_records
        SET serviced_on = $2, meter_reading_id = $3, vendor_id = $4, total = $5, currency = $6,
            notes = $7
      WHERE id = $1`,
    [
      id,
      back.serviced_on,
      back.meter_reading_id,
      back.vendor_id,
      back.total,
      back.currency,
      back.notes,
    ],
  );
  if (after.reading_created === true) await dropReading(client, after.meter_reading_id);
  else if ('reading_value' in diff && back.meter_reading_id && back.reading_value !== null) {
    await client.query('UPDATE public.meter_readings SET value = $2 WHERE id = $1', [
      back.meter_reading_id,
      back.reading_value,
    ]);
  }
  if ('lines' in diff || 'completes' in diff) {
    await restoreChildren(client, event.locationId, id, back);
  }
  const now = await serviceImage(client, await serviceRow(client, id));
  await args.audit({
    action: 'service_record.update',
    entity: { type: 'service_record', id },
    before: image,
    after: now,
    fieldClasses: { total: 'money', lines: 'money' },
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
  });
}

type AttachmentImage = {
  id: string;
  file_id: string | null;
  url: string | null;
  role: string;
  sort: number;
};

/** service_record.delete: the record comes back with its id, lines, completions and files. */
async function undoServiceDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'service_record' || !id) throw notUndoable();
  await requireMoney(args, event.diff);
  const b = beforeOf(event.diff) as unknown as ServiceImage & { attachments?: AttachmentImage[] };
  const { rowCount: exists } = await client.query(
    'SELECT 1 FROM public.service_records WHERE id = $1',
    [id],
  );
  if (exists) throw conflict("Can't undo: that service is back already.");
  const subject = b.thing_id
    ? await client.query('SELECT 1 FROM public.things WHERE id = $1', [b.thing_id])
    : await client.query('SELECT 1 FROM public.places WHERE id = $1', [b.place_id]);
  if (!subject.rowCount) throw conflict("Can't undo: what the service was for is gone.");
  const { rowCount: reading } = await client.query(
    'SELECT 1 FROM public.meter_readings WHERE id = $1',
    [b.meter_reading_id],
  );
  await client.query(
    `INSERT INTO public.service_records (id, location_id, thing_id, place_id, serviced_on,
                                         meter_reading_id, vendor_id, total, currency, notes,
                                         logged_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, kept.current_user_id())`,
    [
      id,
      event.locationId,
      b.thing_id,
      b.place_id,
      b.serviced_on,
      reading ? b.meter_reading_id : null,
      b.vendor_id,
      b.total,
      b.currency,
      b.notes,
    ],
  );
  await restoreChildren(client, event.locationId, id, b);
  for (const a of b.attachments ?? []) {
    await client.query(
      `INSERT INTO public.attachments (id, location_id, file_id, url, service_record_id, role, sort,
                                       created_by)
       SELECT $1, $2, $3, $4, $5, $6, $7, kept.current_user_id()
        WHERE $3::uuid IS NULL OR EXISTS (SELECT 1 FROM public.files f WHERE f.id = $3)
       ON CONFLICT DO NOTHING`,
      [a.id, event.locationId, a.file_id, a.url, id, a.role, a.sort],
    );
  }
  const now = await serviceImage(client, await serviceRow(client, id));
  await args.audit({
    action: 'service_record.delete',
    entity: { type: 'service_record', id },
    before: null,
    after: now,
    fieldClasses: { total: 'money', lines: 'money' },
    subjects: b.thing_id ? [b.thing_id] : [],
    rootThingId: b.thing_id,
  });
}

let registered = false;

/** Registers the handlers (idempotent; schedules/routes.ts). */
export function registerScheduleUndo(): void {
  if (registered) return;
  registered = true;
  for (const action of [
    'schedule.update',
    'schedule.snooze',
    'schedule.skip',
    'schedule.unsnooze',
  ]) {
    registerUndo(action, undoScheduleFields);
  }
  registerUndo('schedule.delete', undoScheduleDelete);
  registerUndo('service_record.create', undoServiceCreate);
  registerUndo('service_record.update', undoServiceUpdate);
  registerUndo('service_record.delete', undoServiceDelete);
}
