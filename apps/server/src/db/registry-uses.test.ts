import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import { insertLocation, ownerTx, seedTenant, type Tenant } from '../../test/tenancy.js';
import { withScope } from './scope.js';

// 0067: a preference may name the stale-reading nudge (step-5 notes, item 1). 0068:
// kept.registry_use_locations() counts a vendor used by a service record, a claim or a fill, and a
// person used by a loan, as well as purchases and things (item 4).

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home
let garage: string; // Ibrahim's second location
let drill: string; // in Home
let corolla: string; // in Garage

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const usesOf = (kind: string, id: string) =>
  withScope(db.pools.app, { userId: ibrahim.userId, mfa: true }, async (_tx, c) =>
    (
      await c.query<{ id: string }>(
        'SELECT u AS id FROM kept.registry_use_locations($1, $2) AS u',
        [kind, id],
      )
    ).rows
      .map((r) => r.id)
      .sort(),
  );
const registry = async (table: 'vendors' | 'people', name: string) => {
  const id = newId();
  const col = table === 'vendors' ? 'name' : 'display_name';
  await own(`INSERT INTO public.${table} (id, owner_account_id, ${col}) VALUES ($1, $2, $3)`, [
    id,
    ibrahim.accountId,
    name,
  ]);
  return id;
};

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'uses-ibrahim', { name: 'Home' });
  const g = await ownerTx(db, (c) =>
    insertLocation(c, { userId: ibrahim.userId, accountId: ibrahim.accountId }, { name: 'Garage' }),
  );
  garage = g.locationId;
  drill = newId();
  corolla = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill'),
                                                                        ($4, $5, $6, 'Corolla')`,
    [drill, ibrahim.locationId, ibrahim.unplacedId, corolla, garage, g.unplacedId],
  );
});

describe('kept.registry_use_locations() (0068)', () => {
  it('counts a vendor used only by a service record', async () => {
    const centre = await registry('vendors', 'Service Centre');
    expect(await usesOf('vendor', centre)).toEqual([]);
    await own(
      `INSERT INTO public.service_records (location_id, thing_id, serviced_on, vendor_id, logged_by)
       VALUES ($1, $2, '2026-09-10', $3, $4)`,
      [garage, corolla, centre, ibrahim.userId],
    );
    expect(await usesOf('vendor', centre)).toEqual([garage]);
  });

  it('counts a vendor used only by a claim', async () => {
    const shop = await registry('vendors', 'Shop');
    await own(
      `INSERT INTO public.claims (location_id, thing_id, opened_on, vendor_id, status, created_by)
       VALUES ($1, $2, '2026-09-20', $3, 'open', $4)`,
      [ibrahim.locationId, drill, shop, ibrahim.userId],
    );
    expect(await usesOf('vendor', shop)).toEqual([ibrahim.locationId]);
  });

  it('counts a vendor used only by a fill, and by several records once per location', async () => {
    const station = await registry('vendors', 'Wataniya, Ring Road');
    for (let i = 0; i < 2; i++) {
      await own(
        `INSERT INTO public.fuel_entries (location_id, thing_id, taken_at, amount, unit, vendor_id,
                                          logged_by)
         VALUES ($1, $2, now() - make_interval(days => $5::int), 40, 'L', $3, $4)`,
        [garage, corolla, station, ibrahim.userId, i + 1],
      );
    }
    await own(
      `INSERT INTO public.service_records (location_id, thing_id, serviced_on, vendor_id, logged_by)
       VALUES ($1, $2, '2026-09-10', $3, $4)`,
      [ibrahim.locationId, drill, station, ibrahim.userId],
    );
    expect(await usesOf('vendor', station)).toEqual([garage, ibrahim.locationId].sort());
  });

  it('counts a person used only by a loan', async () => {
    const murdock = await registry('people', 'Murdock');
    expect(await usesOf('person', murdock)).toEqual([]);
    await own(
      `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, created_by)
       VALUES ($1, $2, 'out', $3, now(), $4)`,
      [ibrahim.locationId, drill, murdock, ibrahim.userId],
    );
    expect(await usesOf('person', murdock)).toEqual([ibrahim.locationId]);
  });
});

describe('notification_preferences_kind_chk (0067)', () => {
  it("takes 'reading_stale', and still refuses a kind it doesn't know", async () => {
    const insert = (kind: string) =>
      own(
        `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
         VALUES ($1, $2, $3, 'email', false)`,
        [ibrahim.userId, ibrahim.locationId, kind],
      );
    await insert('reading_stale');
    // 'stock' became a kind with step 7's low-stock reminders (0103–0104): a made-up one here.
    await expect(insert('not_a_kind')).rejects.toMatchObject({
      code: '23514',
      constraint: 'notification_preferences_kind_chk',
    });
  });
});
