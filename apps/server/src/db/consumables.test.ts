import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope } from './scope.js';

// Step-7 T6 (0084, 0085): "keep at least N" on a consumable thing (D14, plan Q19), under
// row-level security.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owner of Home
let louis: string; // member
let talia: string; // viewer
let batteries: string;
let drill: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const rule = (userId: string, thing: string, min: number | string = 4) =>
  as(userId, (c) =>
    c.query(
      `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
       VALUES ($1, $2, $3, $4)`,
      [thing, ibrahim.locationId, min, userId],
    ),
  );

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'stock-ibrahim');
  louis = await seedUser(db, 'stock-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  talia = await seedUser(db, 'stock-talia');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  batteries = newId();
  drill = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id, quantity)
     VALUES ($1, $3, $4, 'AA batteries',
             (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'batteries'),
             12),
            ($2, $3, $4, 'Drill', NULL, 1)`,
    [batteries, drill, ibrahim.locationId, ibrahim.unplacedId],
  );
});

describe('stock rules (D14)', () => {
  it("a member keeps a minimum on a consumable; a viewer can't", async () => {
    await rule(louis, batteries);
    expect((await pgError(rule(talia, batteries))).code).toBe('42501');
    expect(
      await as(talia, async (c) => (await c.query('SELECT 1 FROM public.stock_rules')).rowCount),
    ).toBe(1);
    expect(
      await as(
        louis,
        async (c) =>
          (
            await c.query('UPDATE public.stock_rules SET min_quantity = 16 WHERE thing_id = $1', [
              batteries,
            ])
          ).rowCount,
      ),
    ).toBe(1);
    expect(
      await as(
        talia,
        async (c) =>
          (await c.query('DELETE FROM public.stock_rules WHERE thing_id = $1', [batteries]))
            .rowCount,
      ),
    ).toBe(0);
  });

  it('only on a consumable thing, once, between 0 and a million', async () => {
    expect(await pgError(rule(louis, drill))).toMatchObject({
      code: '23514',
      constraint: 'stock_rules_consumable',
    });
    expect((await pgError(rule(louis, batteries, 0))).constraint).toBe(
      'stock_rules_min_quantity_chk',
    );
    expect((await pgError(rule(louis, batteries, '1000001'))).constraint).toBe(
      'stock_rules_min_quantity_chk',
    );
    await rule(louis, batteries);
    expect((await pgError(rule(louis, batteries))).constraint).toBe('stock_rules_thing_uq');
  });

  it("goes with its thing, and can't name another location's", async () => {
    const alfred = await seedTenant(db, 'stock-alfred');
    const wrong = as(alfred.userId, (c) =>
      c.query(
        `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
         VALUES ($1, $2, 1, $3)`,
        [batteries, alfred.locationId, alfred.userId],
      ),
    );
    expect((await pgError(wrong)).code).toBe('42501');
    await rule(louis, batteries);
    await own('DELETE FROM public.things WHERE id = $1', [batteries]);
    expect(await own('SELECT 1 FROM public.stock_rules')).toEqual([]);
  });
});
