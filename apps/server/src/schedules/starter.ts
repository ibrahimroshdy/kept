import { STARTER_SCHEDULES, type StarterKey, starterInterval } from '@kept/shared';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import {
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoableUntil,
  undoConflict,
} from '../audit/undo.js';
import { requireRole } from '../things/service.js';
import { liveThingOf, odometerOf } from '../vehicles/meters.js';
import { type Ctx, createSchedule, requireModule } from './service.js';
import type { Schedule } from './view.js';

// Starter schedules for a vehicle (step-5 plan T13; D52, engineering spec §3.4: "editable
// defaults, not manufacturer advice"; Q25): oil change, tyre rotation, brake fluid and air filter,
// whichever comes first. Never made automatically: the person asks, from the empty Schedules tab.
//
// - Made through step 4's own create (schedules/service.ts createSchedule), in one transaction,
//   anchored today at the odometer's latest reading. A key whose name the vehicle already has
//   (normalised, D42) is skipped, so asking twice makes none the second time.
// - The distance side applies only to an odometer in km (Q25); in miles, or with no distance
//   meter, a schedule gets its months alone (no rounded conversion presented as advice).
// - Modules Vehicles (the route's config) and Schedules (here); `schedules-claims.manage`.
// - One undoable event, `schedule.starter` on the thing, names what it made (each schedule's own
//   `schedule.create` is written too, as step 4 writes it). Undo removes the ones still as made
//   (unchanged and never completed); a changed one refuses it, naming who.

export type StarterResult = {
  schedules: Schedule[];
  /** Absent when nothing was made (every name was there already). */
  undo?: { eventId: string; until: string };
};

/** POST /api/v1/things/:id/starter-schedules {keys?} → 201 StarterResult. */
export async function createStarterSchedules(
  ctx: Ctx,
  thingId: string,
  keys?: readonly StarterKey[],
): Promise<StarterResult> {
  const { client } = ctx;
  const thing = await liveThingOf(client, thingId);
  await requireModule(ctx, thing.location_id, 'schedules', 'write');
  await requireRole(client, thing.location_id, 'schedules-claims.manage');
  const meter = await odometerOf(client, thing.id);
  const made: Schedule[] = [];
  for (const s of STARTER_SCHEDULES) {
    if (keys && !keys.includes(s.key)) continue;
    const { rowCount } = await client.query(
      `SELECT 1 FROM public.schedules
        WHERE thing_id = $1 AND kept.normalize(name) = kept.normalize($2)`,
      [thing.id, s.name],
    );
    if (rowCount) continue;
    const interval = starterInterval(s, meter);
    made.push(
      await createSchedule(ctx, {
        subject: { thingId: thing.id },
        name: s.name,
        everyMonths: interval.everyMonths,
        ...(interval.everyUnits && meter
          ? { everyUnits: interval.everyUnits, meterId: meter.id }
          : {}),
      }),
    );
  }
  if (made.length === 0) return { schedules: [] };
  const until = undoableUntil();
  const event = await audited(ctx.tx, {
    locationId: thing.location_id,
    actor: actorOf(ctx.scope),
    action: 'schedule.starter',
    entity: { type: 'thing', id: thing.id },
    after: { schedule_ids: made.map((s) => s.id), names: made.map((s) => s.name) },
    subjects: [thing.id],
    rootThingId: thing.id,
    requestId: ctx.requestId,
    undoableUntil: until,
  });
  return { schedules: made, undo: { eventId: event.id, until: until.toISOString() } };
}

/** schedule.starter: the schedules it made go, while each is still as made. */
async function undoStarter(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const thingId = event.entityId;
  const ids = event.diff.schedule_ids?.after;
  if (event.entityType !== 'thing' || !thingId || !Array.isArray(ids)) throw notUndoable();
  const { rows } = await client.query<{ id: string; changed: boolean }>(
    `SELECT s.id,
            (s.row_version > 1
             OR EXISTS (SELECT 1 FROM public.service_completions c WHERE c.schedule_id = s.id))
              AS changed
       FROM public.schedules s WHERE s.id = ANY ($1::uuid[]) FOR UPDATE OF s`,
    [ids],
  );
  const changed = rows.find((r) => r.changed);
  if (changed) {
    const who = await lastChangedBy(
      client,
      event.locationId,
      { type: 'schedule', id: changed.id },
      event.at,
    );
    throw undoConflict(['schedules'], who);
  }
  const gone = rows.map((r) => r.id);
  await client.query('DELETE FROM public.schedules WHERE id = ANY ($1::uuid[])', [gone]);
  await args.audit({
    action: event.action,
    entity: { type: 'thing', id: thingId },
    before: { schedule_ids: gone },
    after: { schedule_ids: [] },
    subjects: [thingId],
    rootThingId: thingId,
  });
}

let registered = false;

/** Registers the handler (idempotent; vehicles/routes.ts). */
export function registerStarterUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('schedule.starter', undoStarter);
}
