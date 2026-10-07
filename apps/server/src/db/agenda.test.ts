import {
  effectiveModules,
  MODULE_IDS,
  MODULES,
  newId,
  PRESETS,
  type Preset,
  presetModules,
} from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope, withSystem } from './scope.js';

// Step-4 T6 (0053): module state in SQL (the drift test against @kept/shared modules.ts) and the
// agenda view (Q24): one row per live reminder source, its state in the location's own date,
// pausing in its WHERE (§7.6, D162), under the caller's policies.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home
let bruce: string; // viewer of Home
let talia: Tenant; // another household
let tv: string;
let drill: string;
let ladder: string;
let kitchen: string;
let murdock: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

type Row = {
  source_type: string;
  source_id: string;
  kind: string;
  state: string;
  due_period: string;
  module: string;
};
const agenda = (rows: Promise<Row[]>) =>
  rows.then((r) => r.map((x) => `${x.source_type} ${x.kind} ${x.state} ${x.module}`).sort());
const SELECT = `SELECT source_type, source_id, kind, state, due_period, module
                  FROM public.agenda_items WHERE location_id = $1`;
const agendaAs = (userId: string, locationId = ibrahim.locationId) =>
  as(userId, async (c) => (await c.query<Row>(SELECT, [locationId])).rows);

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'agenda-ibrahim');
  bruce = await seedUser(db, 'agenda-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'viewer');
  talia = await seedTenant(db, 'agenda-talia');
  tv = newId();
  drill = newId();
  ladder = newId();
  kitchen = newId();
  murdock = newId();
  const loc = ibrahim.locationId;
  await own(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'Kitchen')`, [
    kitchen,
    loc,
  ]);
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, expires_on)
     VALUES ($1, $4, $5, 'TV', NULL), ($2, $4, $5, 'Drill', NULL),
            ($3, $4, $5, 'Ladder', current_date - 2)`,
    [tv, drill, ladder, loc, ibrahim.unplacedId],
  );
  await own(
    `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Murdock')`,
    [murdock, ibrahim.accountId],
  );
  // The TV: a warranty ending in 20 days (lead 30: expiring), registration due in 5 days.
  await own(
    `INSERT INTO public.warranties (location_id, thing_id, kind, starts_on, ends_on,
                                    registration_deadline, created_by)
     VALUES ($1, $2, 'manufacturer', current_date - 700, current_date + 20, current_date + 5, $3)`,
    [loc, tv, ibrahim.userId],
  );
  // The drill lent to Murdock, due yesterday: overdue.
  await own(
    `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, 'out', $3, now() - interval '10 days', current_date - 1, $4)`,
    [loc, drill, murdock, ibrahim.userId],
  );
  // The boiler service on the Kitchen, 12 months from 355 days ago: due in about 10 days, inside
  // the 14-day lead whichever side of midnight UTC Cairo is on.
  await own(
    `INSERT INTO public.schedules (location_id, place_id, name, every_months, anchor_on, created_by)
     VALUES ($1, $2, 'Boiler service', 12, current_date - 355, $3)`,
    [loc, kitchen, ibrahim.userId],
  );
  // Home insurance on the location itself, expiring in 20 days.
  await own(
    `INSERT INTO public.expiring_documents (location_id, kind, expires_on, created_by)
     VALUES ($1, 'insurance', current_date + 20, $2)`,
    [loc, ibrahim.userId],
  );
});

const EXPECTED = [
  'document expiring expiring paperwork',
  'loan overdue overdue lending',
  'registration due due warranties',
  'schedule due due schedules',
  'thing_expiry overdue overdue schedules',
  'warranty expiring expiring warranties',
];

describe('module state in SQL (§7.6)', () => {
  it('kept.module_on() is effectiveModules() for every preset, module and switch', async () => {
    const mismatches: string[] = [];
    for (const preset of PRESETS) {
      const loc = await ownerTx(db, async (c) => {
        const l = await insertLocation(
          c,
          { userId: ibrahim.userId, accountId: ibrahim.accountId },
          { name: `Preset ${preset}` },
        );
        await c.query('UPDATE public.locations SET preset = $2 WHERE id = $1', [
          l.locationId,
          preset,
        ]);
        return l.locationId;
      });
      for (const override of [null, true, false] as const) {
        for (const target of MODULE_IDS) {
          await own('DELETE FROM public.location_modules WHERE location_id = $1', [loc]);
          const enabled = presetModules(preset as Preset) as Set<string>;
          if (override !== null) {
            await own(
              `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, $2, $3)`,
              [loc, target, override],
            );
            if (override) enabled.add(target);
            else enabled.delete(target);
          }
          // The AI modules' provider rule is the server's, never asked here.
          const expected = effectiveModules(enabled, { providerResolved: true });
          const { rows } = await ownerTx(db, (c) =>
            c.query<{ id: string; on: boolean }>(
              'SELECT m AS id, kept.module_on($1, m) AS on FROM unnest($2::text[]) AS m',
              [loc, [...MODULE_IDS]],
            ),
          );
          for (const r of rows) {
            if (r.on !== expected.has(r.id as never)) {
              mismatches.push(`${preset} ${target}=${override} → ${r.id}: sql ${r.on}`);
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Every dependency the registry declares is one the SQL knows.
    const deps = Object.entries(MODULES).flatMap(([id, m]) => m.deps.map((d) => `${id}→${d}`));
    expect(deps.sort()).toEqual(['fuel→vehicles', 'moving→labels']);
  });

  it('is off for a location the caller cannot see', async () => {
    const on = await as(talia.userId, async (c) => {
      const { rows } = await c.query<{ on: boolean }>(`SELECT kept.module_on($1, 'labels') AS on`, [
        ibrahim.locationId,
      ]);
      return rows[0]?.on;
    });
    expect(on).toBe(false);
  });
});

describe('the agenda (Q24)', () => {
  it("has one row per live source, in the state its location's date gives", async () => {
    expect(await agenda(agendaAs(ibrahim.userId))).toEqual(EXPECTED);
    const periods = (await agendaAs(ibrahim.userId)).map((r) => r.due_period);
    for (const p of periods) expect(p).toMatch(/^(date:\d{4}-\d{2}-\d{2}|meter:\d+(\.\d{1,3})?)$/);
  });

  it("shows a viewer what's due, and another household nothing (RLS)", async () => {
    expect(await agenda(agendaAs(bruce))).toEqual(EXPECTED);
    expect(await agendaAs(talia.userId)).toEqual([]);
    const system = await withSystem(
      db.pools.system,
      async (_tx, c) => (await c.query<Row>(SELECT, [ibrahim.locationId])).rows,
    );
    expect(await agenda(Promise.resolve(system))).toEqual(EXPECTED);
  });

  it("pauses a module's sources while it is off in the location (D162)", async () => {
    await own(
      `INSERT INTO public.location_modules (location_id, module, enabled)
       VALUES ($1, 'warranties', false), ($1, 'lending', false)`,
      [ibrahim.locationId],
    );
    expect(await agenda(agendaAs(ibrahim.userId))).toEqual([
      'document expiring expiring paperwork',
      'schedule due due schedules',
      'thing_expiry overdue overdue schedules',
    ]);
  });

  it('pauses a trashed thing, an ended one, a returned loan and a renewed document', async () => {
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [tv]);
    await own(
      `UPDATE public.things SET lifecycle = 'lost', ended_on = current_date WHERE id = $1`,
      [ladder],
    );
    await own('UPDATE public.loans SET returned_at = now() WHERE thing_id = $1', [drill]);
    const renewed = newId();
    await own(
      `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
       VALUES ($1, $2, 'insurance', current_date + 385, $3)`,
      [renewed, ibrahim.locationId, ibrahim.userId],
    );
    await own(
      `UPDATE public.expiring_documents SET superseded_by_id = $1
        WHERE location_id = $2 AND id <> $1`,
      [renewed, ibrahim.locationId],
    );
    expect(await agenda(agendaAs(ibrahim.userId))).toEqual([
      'document expiring upcoming paperwork',
      'schedule due due schedules',
    ]);
  });

  it("uses the location's own date, and a borrowed thing's due date too (D56)", async () => {
    // Kiritimati is UTC+14 and Pago Pago UTC-11: their dates differ for most of each day.
    const far = await ownerTx(db, async (c) => {
      const l = await insertLocation(
        c,
        { userId: ibrahim.userId, accountId: ibrahim.accountId },
        { name: 'Far' },
      );
      await c.query(`UPDATE public.locations SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [
        l.locationId,
      ]);
      return l;
    });
    const borrowed = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Ladder')`,
      [borrowed, far.locationId, far.unplacedId],
    );
    await own(
      `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, due_on,
                                 created_by)
       VALUES ($1, $2, 'in', $3, now() - interval '3 days',
               (now() AT TIME ZONE 'Pacific/Kiritimati')::date, $4)`,
      [far.locationId, borrowed, murdock, ibrahim.userId],
    );
    expect(await agenda(agendaAs(ibrahim.userId, far.locationId))).toEqual([
      'loan overdue due lending',
    ]);
    await own(`UPDATE public.loans SET due_on = due_on - 1 WHERE thing_id = $1`, [borrowed]);
    expect(await agenda(agendaAs(ibrahim.userId, far.locationId))).toEqual([
      'loan overdue overdue lending',
    ]);
  });

  it('keys a unit schedule by its reading and is due once the reading reaches the lead', async () => {
    const car = newId();
    const meter = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Car')`,
      [car, ibrahim.locationId, ibrahim.unplacedId],
    );
    await own(
      `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, 'distance', 'km')`,
      [meter, ibrahim.locationId, car],
    );
    await own(
      `INSERT INTO public.schedules (location_id, thing_id, name, every_units, meter_id, anchor_on,
                                     anchor_value, created_by)
       VALUES ($1, $2, 'Oil change', 10000, $3, current_date, 50000, $4)`,
      [ibrahim.locationId, car, meter, ibrahim.userId],
    );
    const oil = async () =>
      (await agendaAs(ibrahim.userId)).filter(
        (r) => r.source_type === 'schedule' && r.due_period.startsWith('meter:'),
      );
    expect((await oil())[0]).toMatchObject({ state: 'upcoming', due_period: 'meter:60000' });
    await own(
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
       VALUES ($1, $2, 59000, now())`,
      [ibrahim.locationId, meter],
    );
    expect((await oil())[0]).toMatchObject({ kind: 'due', state: 'due' });
  });
});
