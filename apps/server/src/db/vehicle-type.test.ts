import { newId, VEHICLE_TYPE_KEY } from '@kept/shared';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx, seedTenant, type Tenant } from '../../test/tenancy.js';
import { withScope } from './scope.js';

// Step 5, task 7 (0066): kept.is_vehicle_type() (plan Q2): a type is a vehicle's when it reaches
// the built-in `vehicle` through parent_id or copied_from_id.

const db = await testDb();
let ibrahim: Tenant;

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const as = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  withScope(
    db.pools.app,
    { userId: ibrahim.userId, mfa: true },
    async (_tx, c) => (await c.query<T>(sql, values)).rows,
  );
const builtin = async (key: string) =>
  (
    await own<{ id: string }>(
      'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
      [key],
    )
  )[0]?.id as string;
const isVehicle = async (type: string | null) =>
  (await as<{ v: boolean }>('SELECT kept.is_vehicle_type($1) AS v', [type]))[0]?.v;
const customise = async (key: string) =>
  (
    await as<{ id: string }>('SELECT kept.customise_type($1, $2) AS id', [
      await builtin(key),
      ibrahim.accountId,
    ])
  )[0]?.id as string;
const accountType = async (name: string, parent: string | null) => {
  const id = newId();
  await own(
    `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon)
     VALUES ($1, $2, $3, $4, 'lucide:box')`,
    [id, ibrahim.accountId, parent, name],
  );
  return id;
};

beforeAll(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'vt-ibrahim');
});

describe('kept.is_vehicle_type() (Q2)', () => {
  it('is true for the built-in vehicle and the types under it', async () => {
    for (const key of [VEHICLE_TYPE_KEY, 'car', 'motorbike', 'bicycle', 'generator']) {
      expect(await isVehicle(await builtin(key)), key).toBe(true);
    }
    expect(await isVehicle(await builtin('box_bin'))).toBe(false);
    expect(await isVehicle(null)).toBe(false);
  });

  it('follows a customised copy, and a custom type under one', async () => {
    expect(await isVehicle(await customise('car'))).toBe(true);
    const vehicle = await customise(VEHICLE_TYPE_KEY);
    expect(await isVehicle(await accountType('Tuk-tuk', vehicle))).toBe(true);
    expect(await isVehicle(await accountType('Boat', null))).toBe(false);
  });

  it('is false for a type the caller can’t see', async () => {
    const louis = await seedTenant(db, 'vt-louis');
    const theirs = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon)
       VALUES ($1, $2, $3, 'Van', 'lucide:box')`,
      [theirs, louis.accountId, await builtin('car')],
    );
    expect(await isVehicle(theirs)).toBe(false);
  });
});
