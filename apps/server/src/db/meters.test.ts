import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  asOwner,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  type Tenant,
} from '../../test/tenancy.js';
import { type Scope, withScope } from './scope.js';

// Task 7: core meters, readings and events (engineering spec §1.6, §7.13; D10, D52, D113).

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string): Scope => ({ userId, mfa: false });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

async function thing(t: Tenant, quantity = 1) {
  const id = newId();
  await q(
    as(t.userId),
    `INSERT INTO public.things (id, location_id, place_id, name, quantity)
     VALUES ($1, $2, $3, 'Generator', $4)`,
    [id, t.locationId, t.unplacedId, quantity],
  );
  return id;
}

const meter = (t: Tenant, thingId: string) =>
  q<{ id: string }>(
    as(t.userId),
    `INSERT INTO public.meters (location_id, thing_id, kind, unit) VALUES ($1, $2, 'hours', 'h')
     RETURNING id`,
    [t.locationId, thingId],
  ).then((r) => r[0]?.id as string);

describe('meters and quantity (D10)', () => {
  let a: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  it('keeps a thing with a meter at quantity 1', async () => {
    const id = await thing(a);
    await meter(a, id);
    const err = await pgError(
      q(as(a.userId), 'UPDATE public.things SET quantity = 2 WHERE id = $1', [id]),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'things_quantity_one' });
    // A second meter is fine, and still can't lift the quantity.
    await meter(a, id);
    expect(
      await pgError(q(as(a.userId), 'UPDATE public.things SET quantity = 2 WHERE id = $1', [id])),
    ).toMatchObject({ constraint: 'things_quantity_one' });
  });

  it('refuses a meter on a thing whose quantity is not 1', async () => {
    const id = await thing(a, 3);
    expect(await pgError(meter(a, id))).toMatchObject({
      code: '23514',
      constraint: 'things_quantity_one',
    });
  });
});

describe('readings', () => {
  it('follow their meter and thing across a move (ON UPDATE CASCADE)', async () => {
    const a = await seedTenant(db, 'a');
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const id = await thing(a);
    const m = await meter(a, id);
    await q(
      as(a.userId),
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
       VALUES ($1, $2, 10, now())`,
      [a.locationId, m],
    );
    await q(
      as(a.userId),
      `INSERT INTO public.meter_events (location_id, meter_id, kind, at, "offset")
       VALUES ($1, $2, 'replaced', now(), 10)`,
      [a.locationId, m],
    );
    await ownerTx(db, (c) =>
      c.query('UPDATE public.things SET location_id = $1, place_id = $2 WHERE id = $3', [
        flat.locationId,
        flat.unplacedId,
        id,
      ]),
    );
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT (SELECT location_id FROM public.meters WHERE id = $1) AS m,
                (SELECT location_id FROM public.meter_readings WHERE meter_id = $1) AS r,
                (SELECT location_id FROM public.meter_events WHERE meter_id = $1) AS e`,
        [m],
      ),
    );
    expect(rows[0]).toEqual({ m: flat.locationId, r: flat.locationId, e: flat.locationId });
  });

  it('refuses a negative value, and a reading on a meter of another location', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const m = await meter(a, await thing(a));
    const theirs = await meter(b, await thing(b));
    const read = (loc: string, meterId: string, value: number) =>
      q(
        as(a.userId),
        `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
         VALUES ($1, $2, $3, now())`,
        [loc, meterId, value],
      );
    expect(await pgError(read(a.locationId, m, -1))).toMatchObject({
      code: '23514',
      constraint: 'meter_readings_value_chk',
    });
    // B's meter from A's location: the composite foreign key, never B's row.
    expect((await pgError(read(a.locationId, theirs, 1))).code).toBe('23503');
    expect((await pgError(read(b.locationId, theirs, 1))).code).toBe('42501');
  });
});
