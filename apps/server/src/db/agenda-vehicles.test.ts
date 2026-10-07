import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx, seedTenant, type Tenant } from '../../test/tenancy.js';
import { withScope, withSystem } from './scope.js';

// Step 5, task 7 (0066): the agenda's vehicle rows (D52, D113; plan Q2, Q19; step 4's Q2, Q3,
// Q5): the stale-reading nudge, a vehicle's documents with Vehicles on, and a unit schedule due
// from its estimated date. The same rows reach the reminder scan (kept_system).

const db = await testDb();

let ibrahim: Tenant;
let corolla: string;
let odometer: string;

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const asUser = <T extends pg.QueryResultRow>(userId: string, sql: string, values: unknown[] = []) =>
  withScope(
    db.pools.app,
    { userId, mfa: true },
    async (_tx, c) => (await c.query<T>(sql, values)).rows,
  );
const asScan = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  withSystem(db.pools.system, async (_tx, c) => (await c.query<T>(sql, values)).rows);

const builtin = async (key: string) =>
  (
    await own<{ id: string }>(
      'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
      [key],
    )
  )[0]?.id as string;

async function thingOf(t: Tenant, name: string, typeKey: string | null): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, t.locationId, t.unplacedId, name, typeKey ? await builtin(typeKey) : null],
  );
  return id;
}

async function meterOf(t: Tenant, thing: string, nudge: number | null = 30): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit, nudge_days)
     VALUES ($1, $2, $3, 'distance', 'km', $4)`,
    [id, t.locationId, thing, nudge],
  );
  return id;
}

/** A reading exactly `days` days before now, and its local date in Cairo. */
async function readDaysAgo(m: string, days: number, value: number, t = ibrahim): Promise<string> {
  const { rows } = await ownerTx(db, (c) =>
    c.query<{ d: string }>(
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
       VALUES ($1, $2, $3, now() - make_interval(days => $4))
       RETURNING (taken_at AT TIME ZONE 'Africa/Cairo')::date::text AS d`,
      [t.locationId, m, value, days],
    ),
  );
  return rows[0]?.d as string;
}

/** The local date in Cairo `days` days (of 24 hours) from now. */
const localIn = async (days: number) =>
  (
    await own<{ d: string }>(
      `SELECT ((now() + make_interval(days => $1)) AT TIME ZONE 'Africa/Cairo')::date::text AS d`,
      [days],
    )
  )[0]?.d as string;
const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

type Row = {
  source_type: string;
  source_id: string;
  thing_id: string | null;
  kind: string;
  state: string;
  due_on: string | null;
  due_value: string | null;
  due_period: string;
  module: string | null;
  meter_id: string | null;
  estimated_on: string | null;
  estimated: boolean;
};
const AGENDA = `SELECT source_type, source_id, thing_id, kind, state, due_on::text,
                       due_value::text, due_period, module, meter_id, estimated_on::text,
                       estimated
                  FROM public.agenda_items WHERE source_type = $1 ORDER BY source_id`;

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'agv-ibrahim', { name: 'Garage' });
  corolla = await thingOf(ibrahim, 'Corolla', 'car');
  odometer = await meterOf(ibrahim, corolla);
});

describe('reading_stale (D52, Q19)', () => {
  it('is due from the latest reading’s local day plus nudge_days, for the scan too', async () => {
    const readOn = await readDaysAgo(odometer, 31, 52340);
    const expected = {
      source_type: 'reading_stale',
      source_id: odometer,
      thing_id: corolla,
      kind: 'due',
      state: 'due',
      due_on: plusDays(readOn, 30),
      due_value: null,
      due_period: `date:${plusDays(readOn, 30)}`,
      module: null,
      meter_id: odometer,
      estimated_on: null,
      estimated: false,
    };
    expect(await asUser<Row>(ibrahim.userId, AGENDA, ['reading_stale'])).toEqual([expected]);
    expect(await asScan<Row>(AGENDA, ['reading_stale'])).toEqual([expected]);
    // A newer reading moves the day on; it's upcoming again.
    const newer = await readDaysAgo(odometer, 2, 52900);
    const [row] = await asUser<Row>(ibrahim.userId, AGENDA, ['reading_stale']);
    expect(row).toMatchObject({ state: 'upcoming', due_on: plusDays(newer, 30) });
  });

  it('rolls forward each period while no reading comes, its key the same within a period', async () => {
    const readOn = await readDaysAgo(odometer, 75, 52340);
    // 75 days on with a 30-day nudge: the second step (day 60) is the period it is in.
    const [row] = await asUser<Row>(ibrahim.userId, AGENDA, ['reading_stale']);
    expect(row).toMatchObject({
      state: 'due',
      due_on: plusDays(readOn, 60),
      due_period: `date:${plusDays(readOn, 60)}`,
    });
  });

  it('needs a reading, a nudge interval and a live thing in use', async () => {
    const generator = await thingOf(ibrahim, 'Generator', 'generator');
    await meterOf(ibrahim, generator); // no reading yet
    const bike = await thingOf(ibrahim, 'Motorbike', 'motorbike');
    await readDaysAgo(await meterOf(ibrahim, bike, null), 40, 100); // no nudge
    const sold = await thingOf(ibrahim, 'Old car', 'car');
    await readDaysAgo(await meterOf(ibrahim, sold), 40, 100);
    await own(`UPDATE public.things SET lifecycle = 'sold' WHERE id = $1`, [sold]);
    const trashed = await thingOf(ibrahim, 'Scooter', 'motorbike');
    await readDaysAgo(await meterOf(ibrahim, trashed), 40, 100);
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [trashed]);
    expect(await asUser<Row>(ibrahim.userId, AGENDA, ['reading_stale'])).toEqual([]);
  });

  it('shows another household nothing', async () => {
    await readDaysAgo(odometer, 31, 52340);
    const louis = await seedTenant(db, 'agv-louis');
    expect(await asUser<Row>(louis.userId, AGENDA, ['reading_stale'])).toEqual([]);
    expect(await asUser(louis.userId, 'SELECT * FROM kept.meter_estimate($1)', [odometer])).toEqual(
      [],
    );
  });
});

describe('documents on vehicles (step 4’s Q5)', () => {
  const doc = async (thing: string) => {
    const id = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, thing_id, kind, expires_on,
                                              created_by)
       VALUES ($1, $2, $3, 'registration', current_date + 10, $4)`,
      [id, ibrahim.locationId, thing, ibrahim.userId],
    );
    return id;
  };
  const modules = (paperwork: boolean, vehicles: boolean) =>
    own(
      `INSERT INTO public.location_modules (location_id, module, enabled)
       VALUES ($1, 'paperwork', $2), ($1, 'vehicles', $3)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = excluded.enabled`,
      [ibrahim.locationId, paperwork, vehicles],
    );

  it('remind while Paperwork or Vehicles is on; other things’ only with Paperwork', async () => {
    const licence = await doc(corolla);
    const lease = await doc(await thingOf(ibrahim, 'Washing machine', null));
    const ids = async (read: typeof asScan) =>
      (await read<Row>(AGENDA, ['document'])).map((r) => [r.source_id, r.module]);
    await modules(false, true);
    expect(await ids(asScan)).toEqual([[licence, 'vehicles']]);
    expect(await ids((sql, v) => asUser(ibrahim.userId, sql, v))).toEqual([[licence, 'vehicles']]);
    await modules(true, false);
    expect((await ids(asScan)).sort()).toEqual(
      [
        [licence, 'paperwork'],
        [lease, 'paperwork'],
      ].sort(),
    );
    await modules(false, false);
    expect(await ids(asScan)).toEqual([]);
  });
});

describe('estimated due dates (D52; step 4’s Q2)', () => {
  it('make a unit schedule due from the day the meter is expected at its due-from reading', async () => {
    // 100 km a day: 50,000 sixty days ago, 56,000 today. Oil every 10,000 km from 50,000: due
    // at 60,000, due from 59,000, expected in 30 days.
    await readDaysAgo(odometer, 60, 50000);
    await readDaysAgo(odometer, 0, 56000);
    const oil = newId();
    await own(
      `INSERT INTO public.schedules (id, location_id, thing_id, name, every_units, meter_id,
                                     anchor_on, anchor_value, created_by)
       VALUES ($1, $2, $3, 'Oil change', 10000, $4, current_date - 60, 50000, $5)`,
      [oil, ibrahim.locationId, corolla, odometer, ibrahim.userId],
    );
    const [row] = await asScan<Row>(AGENDA, ['schedule']);
    expect(row).toMatchObject({
      source_id: oil,
      state: 'upcoming',
      due_on: null,
      due_value: '60000',
      due_period: 'meter:60000',
      estimated_on: await localIn(30),
      estimated: true,
    });
    // Twenty-seven days on without a reading, the estimate says due in three days...
    await own(
      `UPDATE public.meter_readings SET taken_at = taken_at - interval '27 days'
        WHERE meter_id = $1`,
      [odometer],
    );
    const [later] = await asScan<Row>(AGENDA, ['schedule']);
    expect(later).toMatchObject({ state: 'upcoming', estimated_on: await localIn(3) });
    // ...and past the estimated day it is due, by its estimate, under the same key.
    await own(
      `UPDATE public.meter_readings SET taken_at = taken_at - interval '5 days'
        WHERE meter_id = $1`,
      [odometer],
    );
    const [due] = await asUser<Row>(ibrahim.userId, AGENDA, ['schedule']);
    expect(due).toMatchObject({
      kind: 'due',
      state: 'due',
      due_period: 'meter:60000',
      estimated_on: await localIn(-2),
      estimated: true,
    });
    const [next] = await asUser<{ state: string; estimated: boolean; basis: string }>(
      ibrahim.userId,
      `SELECT state, estimated, basis FROM kept.schedule_next($1, $2)`,
      [oil, await localIn(0)],
    );
    expect(next).toEqual({ state: 'due', estimated: true, basis: 'units' });
    // Sixty days without a reading: "unknown — reading needed", and no estimated date.
    await own(
      `UPDATE public.meter_readings SET taken_at = taken_at - interval '30 days'
        WHERE meter_id = $1`,
      [odometer],
    );
    const [unknown] = await asUser<Row>(ibrahim.userId, AGENDA, ['schedule']);
    expect(unknown).toMatchObject({ state: 'upcoming', estimated_on: null, estimated: false });
  });
});
