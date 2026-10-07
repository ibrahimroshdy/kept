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

// Step-7 T5 (0082, 0083): a Kept import adopts each printed label's code where it is free on
// this server (plan Q9); a taken one becomes a `kept` legacy code instead.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // importing into Home
let alfred: Tenant; // another household, holding a code already
let louis: string; // member
let run: string;
let drill: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const adopt = (
  userId: string,
  code: string,
  state: string,
  thing: string | null,
  place: string | null = null,
) =>
  as(userId, async (c) => {
    const { rows } = await c.query<{ v: boolean }>(
      'SELECT kept.adopt_short_code($1, $2, $3, $4, $5) AS v',
      [run, code, state, thing, place],
    );
    return rows[0]?.v;
  });

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'adopt-ibrahim');
  alfred = await seedTenant(db, 'adopt-alfred');
  louis = await seedUser(db, 'adopt-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  drill = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
    [drill, ibrahim.locationId, ibrahim.unplacedId],
  );
  run = newId();
  await own(
    `INSERT INTO public.import_runs (id, location_id, source, status, created_by)
     VALUES ($1, $2, 'kept_zip', 'running', $3)`,
    [run, ibrahim.locationId, ibrahim.userId],
  );
  await own(
    `INSERT INTO public.short_ids (code, location_id, place_id, state)
     VALUES ('7KQ2MA', $1, $2, 'assigned')`,
    [alfred.locationId, alfred.unplacedId],
  );
});

describe('kept.adopt_short_code (plan Q9)', () => {
  it('adopts a free code as the primary label; a taken one is false and stays where it was', async () => {
    expect(await adopt(ibrahim.userId, '3F9XR2', 'assigned', drill)).toBe(true);
    const [mine] = await own<{ thing_id: string; is_primary: boolean; location_id: string }>(
      `SELECT thing_id, is_primary, location_id FROM public.short_ids WHERE code = '3F9XR2'`,
    );
    expect(mine).toEqual({ thing_id: drill, is_primary: true, location_id: ibrahim.locationId });
    // A second code for the same thing is adopted, not primary.
    expect(await adopt(ibrahim.userId, '3F9XR3', 'assigned', drill)).toBe(true);
    const [second] = await own<{ is_primary: boolean }>(
      `SELECT is_primary FROM public.short_ids WHERE code = '3F9XR3'`,
    );
    expect(second?.is_primary).toBe(false);

    expect(await adopt(ibrahim.userId, '7KQ2MA', 'assigned', drill)).toBe(false);
    const [theirs] = await own<{ location_id: string; place_id: string }>(
      `SELECT location_id, place_id FROM public.short_ids WHERE code = '7KQ2MA'`,
    );
    expect(theirs).toEqual({ location_id: alfred.locationId, place_id: alfred.unplacedId });
  });

  it('takes blank and retired labels, and refuses a target outside the run', async () => {
    expect(await adopt(ibrahim.userId, '4G8HJ1', 'blank', null)).toBe(true);
    expect(await adopt(ibrahim.userId, '4G8HJ2', 'retired', drill)).toBe(true);
    expect((await pgError(adopt(ibrahim.userId, '4G8HJ3', 'assigned', null))).code).toBe('22023');
    expect(
      (await pgError(adopt(ibrahim.userId, '4G8HJ4', 'assigned', null, alfred.unplacedId))).code,
    ).toBe('42501');
  });

  it("is the run's creator's alone, while it runs", async () => {
    expect((await pgError(adopt(louis, '5H7KM1', 'assigned', drill))).code).toBe('42501');
    expect((await pgError(adopt(alfred.userId, '5H7KM2', 'blank', null))).code).toBe('42501');
  });

  it('a `kept` legacy code keeps an old label working', async () => {
    await own(
      `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
       VALUES ($1, 'kept', '', '7KQ2MA', $2)`,
      [ibrahim.locationId, drill],
    );
    const [row] = await own<{ source: string }>(
      `SELECT source FROM public.legacy_codes WHERE thing_id = $1`,
      [drill],
    );
    expect(row?.source).toBe('kept');
  });
});
