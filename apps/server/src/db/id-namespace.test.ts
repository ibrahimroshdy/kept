import { newId } from '@kept/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx, pgError, seedTenant, type Tenant } from '../../test/tenancy.js';
import { type Scope, withScope } from './scope.js';

// Things and places share one id namespace (route security review #35, migration 0030): a place
// may not take an id a thing has, anywhere, nor the reverse, so an id names one entity in the
// history, the codes and the offline snapshot. The conversions keep the UUID on purpose
// (Q14) and are the only writers exempt. As kept_app.

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string): Scope => ({ userId, mfa: false });

const run = (t: Tenant, text: string, values: unknown[]) =>
  withScope(app, as(t.userId), async (_tx, client) => client.query(text, values));

const insertPlace = (t: Tenant, id: string) =>
  run(
    t,
    `INSERT INTO public.places (id, location_id, name, kind_key) VALUES ($1, $2, 'Taken', 'room')`,
    [id, t.locationId],
  );

const insertThing = (t: Tenant, id: string) =>
  run(
    t,
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Taken')`,
    [id, t.locationId, t.unplacedId],
  );

describe('one id namespace for things and places (#35)', () => {
  let a: Tenant;
  let b: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    b = await seedTenant(db, 'b');
  });

  it("refuses a place with a thing's id, in the same tenant or another, as a key clash", async () => {
    const id = newId();
    await insertThing(a, id);
    for (const t of [a, b]) {
      const err = await pgError(insertPlace(t, id));
      expect(err).toMatchObject({ code: '23505', constraint: 'inventory_ids_pkey' });
    }
  });

  it("refuses a thing with a place's id, in the same tenant or another", async () => {
    const id = newId();
    await insertPlace(a, id);
    for (const t of [a, b]) {
      const err = await pgError(insertThing(t, id));
      expect(err).toMatchObject({ code: '23505', constraint: 'inventory_ids_pkey' });
    }
    // An Unplaced area's id is a place's too.
    const err = await pgError(insertThing(b, a.unplacedId));
    expect(err).toMatchObject({ code: '23505', constraint: 'inventory_ids_pkey' });
  });

  it('lets both conversions keep the id (Q14)', async () => {
    const box = newId();
    await insertPlace(a, box);
    await run(a, 'SELECT kept.convert_place_to_container($1, NULL)', [box]);
    await run(a, 'SELECT kept.convert_container_to_place($1, NULL)', [box]);
    const { rows } = await ownerTx(db, (c) =>
      c.query('SELECT count(*)::int AS n FROM public.places WHERE id = $1', [box]),
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('still takes fresh ids, and a trashed thing keeps its id reserved', async () => {
    await insertThing(a, newId());
    await insertPlace(a, newId());
    const gone = newId();
    await insertThing(a, gone);
    await ownerTx(db, (c) =>
      c.query('UPDATE public.things SET deleted_at = now() WHERE id = $1', [gone]),
    );
    const err = await pgError(insertPlace(a, gone));
    expect(err.code).toBe('23505');
  });
});
