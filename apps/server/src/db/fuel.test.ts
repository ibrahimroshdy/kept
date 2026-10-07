import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope } from './scope.js';

// Step 5, task 6 (0064, 0065): fuel entries, document costs and the vehicle report's thing
// (engineering spec §1.6, §7.1, §7.13; D28, D170, D201; plan Q5, Q11, Q14, Q17).

const db = await testDb();

let ibrahim: Tenant; // owns Garage
let alfred: string; // member
let bruce: string; // admin
let louis: Tenant; // another household
let corolla: string;
let odometer: string;
let station: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

async function carOf(t: Tenant, name: string): Promise<{ car: string; meter: string }> {
  const car = newId();
  const meter = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM public.types
                               WHERE owner_account_id IS NULL AND builtin_key = 'car'))`,
    [car, t.locationId, t.unplacedId, name],
  );
  await own(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit)
     VALUES ($1, $2, $3, 'distance', 'km')`,
    [meter, t.locationId, car],
  );
  return { car, meter };
}

async function vendorOf(t: Tenant, name: string): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.vendors (id, owner_account_id, name, kind) VALUES ($1, $2, $3, 'other')`,
    [id, t.accountId, name],
  );
  return id;
}

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'fuel-ibrahim', { name: 'Garage' });
  alfred = await seedUser(db, 'fuel-alfred');
  bruce = await seedUser(db, 'fuel-bruce');
  await addMember(db, ibrahim.locationId, alfred, 'member');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedTenant(db, 'fuel-louis');
  ({ car: corolla, meter: odometer } = await carOf(ibrahim, 'Corolla'));
  station = await vendorOf(ibrahim, 'Wataniya, Ring Road');
});

const reading = (userId: string, value: number, meter = odometer, t = ibrahim) =>
  as(userId, async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.meter_readings (id, location_id, meter_id, value, taken_at, source,
                                          logged_by)
       VALUES ($1, $2, $3, $4, now(), 'fuel', $5)`,
      [id, t.locationId, meter, value, userId],
    );
    return id;
  });

type Fill = {
  thing?: string;
  location?: string;
  amount?: string;
  unit?: string;
  cost?: string | null;
  currency?: string | null;
  vendor?: string | null;
  reading?: string | null;
};
const fill = (userId: string, f: Fill = {}) =>
  as(userId, async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.fuel_entries (id, location_id, thing_id, taken_at, amount, unit, cost,
                                        currency, vendor_id, meter_reading_id, logged_by)
       VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        f.location ?? ibrahim.locationId,
        f.thing ?? corolla,
        f.amount ?? '38.5',
        f.unit ?? 'L',
        f.cost === undefined ? '577.50' : f.cost,
        f.currency === undefined ? 'EGP' : f.currency,
        f.vendor ?? null,
        f.reading ?? null,
        userId,
      ],
    );
    return id;
  });

describe('fuel_entries', () => {
  it('holds amounts, units and money as §7.13 says', async () => {
    expect(await pgError(fill(alfred, { currency: null }))).toMatchObject({
      code: '23514',
      constraint: 'fuel_entries_money_chk',
    });
    expect(await pgError(fill(alfred, { amount: '0' }))).toMatchObject({
      code: '23514',
      constraint: 'fuel_entries_amount_chk',
    });
    expect(await pgError(fill(alfred, { unit: 'l' }))).toMatchObject({
      code: '23514',
      constraint: 'fuel_entries_unit_chk',
    });
    // No cost at all is fine (Money off, or not known); a charge in kWh; a US gallon.
    await fill(alfred, { cost: null, currency: null });
    await fill(alfred, { unit: 'kWh', amount: '41.2' });
    await fill(alfred, { unit: 'gal', amount: '10.1' });
  });

  it('is changed or removed by whoever logged it, or an admin (logs.edit-own)', async () => {
    const mine = await fill(alfred, { vendor: station });
    const brucesOwn = await fill(bruce);
    const update = (userId: string, id: string) =>
      as(
        userId,
        async (c) =>
          (await c.query(`UPDATE public.fuel_entries SET note = 'Full tank' WHERE id = $1`, [id]))
            .rowCount,
      );
    const remove = (userId: string, id: string) =>
      as(
        userId,
        async (c) =>
          (await c.query('DELETE FROM public.fuel_entries WHERE id = $1', [id])).rowCount,
      );
    expect(await update(alfred, mine)).toBe(1);
    expect(await update(alfred, brucesOwn)).toBe(0);
    expect(await remove(alfred, brucesOwn)).toBe(0);
    // Logged as someone else: refused.
    expect(
      await pgError(
        as(alfred, (c) =>
          c.query(
            `INSERT INTO public.fuel_entries (location_id, thing_id, taken_at, amount, unit,
                                              logged_by)
             VALUES ($1, $2, now(), 30, 'L', $3)`,
            [ibrahim.locationId, corolla, bruce],
          ),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    // No grant on who logged it or which thing it is.
    expect(
      await pgError(
        as(alfred, (c) =>
          c.query('UPDATE public.fuel_entries SET logged_by = $2 WHERE id = $1', [mine, bruce]),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    expect(await remove(bruce, mine)).toBe(1);
    expect(await remove(alfred, brucesOwn)).toBe(0);
  });

  it('refuses another household’s car, vendor, and a reading of another thing', async () => {
    const { car: van, meter: vanMeter } = await carOf(louis, 'Van');
    expect(await pgError(fill(alfred, { location: louis.locationId, thing: van }))).toMatchObject({
      code: '42501',
    });
    expect(await pgError(fill(alfred, { thing: van }))).toMatchObject({ code: '23503' });
    const theirs = await vendorOf(louis, 'Their station');
    expect(await pgError(fill(alfred, { vendor: theirs }))).toMatchObject({
      code: '42501',
      constraint: 'fuel_entries_vendor_account',
    });
    const { meter: genMeter } = await carOf(ibrahim, 'Generator');
    const wrong = await reading(alfred, 120, genMeter);
    expect(await pgError(fill(alfred, { reading: wrong }))).toMatchObject({
      code: '23514',
      constraint: 'fuel_entries_reading_thing',
    });
    expect(await pgError(reading(alfred, 1, vanMeter, louis))).toMatchObject({ code: '42501' });
  });

  it('owns its reading alone (Q11), and loses it when the reading goes', async () => {
    const r = await reading(alfred, 52340);
    const f = await fill(alfred, { reading: r });
    expect(await pgError(fill(alfred, { reading: r }))).toMatchObject({
      code: '23505',
      constraint: 'fuel_entries_reading_uq',
    });
    await as(alfred, (c) => c.query('DELETE FROM public.meter_readings WHERE id = $1', [r]));
    expect(
      await own('SELECT meter_reading_id FROM public.fuel_entries WHERE id = $1', [f]),
    ).toEqual([{ meter_reading_id: null }]);
  });

  it('comes back from undo with its logger (Q14, D150)', async () => {
    const f = await fill(alfred, { vendor: station });
    const row = (await own<Record<string, unknown>>('SELECT * FROM public.fuel_entries')).at(0);
    await as(bruce, (c) => c.query('DELETE FROM public.fuel_entries WHERE id = $1', [f]));
    const event = newId();
    await own(
      `INSERT INTO public.audit_events (id, location_id, actor_type, actor_id, action, entity_type,
                                        entity_id, diff, undoable_until)
       VALUES ($1, $2, 'user', $3, 'fuel_entry.delete', 'fuel_entry', $4, $5,
               now() + interval '7 days')`,
      [
        event,
        ibrahim.locationId,
        bruce,
        f,
        JSON.stringify({ logged_by: { before: alfred, after: null, class: 'plain' } }),
      ],
    );
    await withScope(db.pools.app, { userId: bruce, mfa: true }, async (_tx, c) => {
      await c.query(`SELECT set_config('app.undo', $1, true)`, [event]);
      await c.query(
        `INSERT INTO public.fuel_entries (id, location_id, thing_id, taken_at, amount, unit,
                                          cost, currency, vendor_id, logged_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          f,
          ibrahim.locationId,
          corolla,
          row?.taken_at,
          row?.amount,
          row?.unit,
          row?.cost,
          row?.currency,
          station,
          alfred,
        ],
      );
    });
    expect(await own('SELECT logged_by FROM public.fuel_entries WHERE id = $1', [f])).toEqual([
      { logged_by: alfred },
    ]);
  });
});

describe('moves and merges', () => {
  it('a move carries the fills and their receipts; across accounts the station and the file follow', async () => {
    const r = await reading(alfred, 52340);
    const f = await fill(alfred, { vendor: station, reading: r });
    const file = newId();
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
      [
        file,
        ibrahim.locationId,
        `f/${ibrahim.locationId}/${file}`,
        createHash('sha256').update(file).digest('hex'),
        alfred,
      ],
    );
    const receipt = newId();
    await own(
      `INSERT INTO public.attachments (id, location_id, file_id, fuel_entry_id, role, created_by)
       VALUES ($1, $2, $3, $4, 'receipt', $5)`,
      [receipt, ibrahim.locationId, file, f, alfred],
    );
    // Ibrahim takes the Corolla to Louis's household, where he is a member.
    await addMember(db, louis.locationId, ibrahim.userId, 'member');
    await as(ibrahim.userId, (c) =>
      c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
        [corolla],
        louis.locationId,
        louis.unplacedId,
      ]),
    );
    const [moved] = await own<{
      location_id: string;
      vendor: string;
      vendor_account: string;
      reading_location: string;
    }>(
      `SELECT f.location_id, v.name AS vendor, v.owner_account_id AS vendor_account,
              r.location_id AS reading_location
         FROM public.fuel_entries f
         JOIN public.vendors v ON v.id = f.vendor_id
         JOIN public.meter_readings r ON r.id = f.meter_reading_id
        WHERE f.id = $1`,
      [f],
    );
    expect(moved).toEqual({
      location_id: louis.locationId,
      vendor: 'Wataniya, Ring Road',
      vendor_account: louis.accountId,
      reading_location: louis.locationId,
    });
    const [att] = await own<{ location_id: string; file_location: string; file_id: string }>(
      `SELECT a.location_id, f.location_id AS file_location, a.file_id
         FROM public.attachments a JOIN public.files f ON f.id = a.file_id WHERE a.id = $1`,
      [receipt],
    );
    expect(att).toMatchObject({ location_id: louis.locationId, file_location: louis.locationId });
  });

  it('merging a vendor moves the fills’, services’ and claims’ references', async () => {
    const f = await fill(alfred, { vendor: station });
    const service = newId();
    await own(
      `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, vendor_id,
                                           logged_by)
       VALUES ($1, $2, $3, '2026-09-01', $4, $5)`,
      [service, ibrahim.locationId, corolla, station, alfred],
    );
    const same = await vendorOf(ibrahim, 'Wataniya');
    const moved = await as(
      ibrahim.userId,
      async (c) =>
        (
          await c.query<{ n: number }>(`SELECT kept.merge_registry('vendor', $1, $2) AS n`, [
            station,
            same,
          ])
        ).rows[0]?.n,
    );
    expect(moved).toBe(2);
    expect(
      await own(
        `SELECT (SELECT vendor_id FROM public.fuel_entries WHERE id = $1) AS fill,
                (SELECT vendor_id FROM public.service_records WHERE id = $2) AS service`,
        [f, service],
      ),
    ).toEqual([{ fill: same, service: same }]);
  });
});

describe('document costs (Q5)', () => {
  it('carries an issue date and a cost, null together with its currency', async () => {
    const doc = await as(alfred, async (c) => {
      const id = newId();
      await c.query(
        `INSERT INTO public.expiring_documents (id, location_id, thing_id, kind, expires_on,
                                                created_by)
         VALUES ($1, $2, $3, 'registration', '2027-03-01', $4)`,
        [id, ibrahim.locationId, corolla, alfred],
      );
      return id;
    });
    const set = (sql: string) =>
      as(alfred, (c) =>
        c.query(`UPDATE public.expiring_documents SET ${sql} WHERE id = $1`, [doc]),
      );
    await set(`issued_on = '2026-03-01', cost = 1250, currency = 'EGP'`);
    expect(await pgError(set('currency = NULL'))).toMatchObject({
      code: '23514',
      constraint: 'expiring_documents_cost_chk',
    });
    expect(await pgError(set('cost = -1'))).toMatchObject({
      code: '23514',
      constraint: 'expiring_documents_cost_chk',
    });
    expect(await pgError(set(`issued_on = '2027-03-02'`))).toMatchObject({
      code: '23514',
      constraint: 'expiring_documents_issued_chk',
    });
  });
});

describe('the vehicle report’s thing (Q17)', () => {
  const run = (userId: string, t: Tenant, kind: string, thing: string | null) =>
    as(userId, (c) =>
      c.query(
        `INSERT INTO public.report_runs (user_id, location_id, location_ids, kind, thing_id)
         VALUES ($1, $2, ARRAY[$2::uuid], $3, $4)`,
        [userId, t.locationId, kind, thing],
      ),
    );

  it('names a thing of its own location, only for vehicle_history', async () => {
    expect(await pgError(run(alfred, ibrahim, 'vehicle_history', null))).toMatchObject({
      code: '23514',
      constraint: 'report_runs_thing_chk',
    });
    expect(await pgError(run(alfred, ibrahim, 'inventory', corolla))).toMatchObject({
      code: '23514',
      constraint: 'report_runs_thing_chk',
    });
    const { car: van } = await carOf(louis, 'Van');
    expect(await pgError(run(alfred, ibrahim, 'vehicle_history', van))).toMatchObject({
      code: '23503',
    });
    // Account-scoped: never a vehicle's.
    expect(
      await pgError(
        as(ibrahim.userId, (c) =>
          c.query(
            `INSERT INTO public.report_runs (user_id, owner_account_id, location_ids, kind,
                                             thing_id)
             VALUES ($1, $2, ARRAY[$3::uuid], 'vehicle_history', $4)`,
            [ibrahim.userId, ibrahim.accountId, ibrahim.locationId, corolla],
          ),
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'report_runs_thing_chk' });
    await run(alfred, ibrahim, 'vehicle_history', corolla);
  });

  it('follows its car across a move, and goes with it', async () => {
    await run(ibrahim.userId, ibrahim, 'vehicle_history', corolla);
    const flat = await ownerTx(db, (c) => insertLocation(c, ibrahim, { name: 'Flat' }));
    await as(ibrahim.userId, (c) =>
      c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
        [corolla],
        flat.locationId,
        flat.unplacedId,
      ]),
    );
    expect(await own('SELECT location_id, location_ids FROM public.report_runs')).toEqual([
      { location_id: flat.locationId, location_ids: [flat.locationId] },
    ]);
    await own('DELETE FROM public.things WHERE id = $1', [corolla]);
    expect(await own('SELECT 1 FROM public.report_runs')).toEqual([]);
  });
});
