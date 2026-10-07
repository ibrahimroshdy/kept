import { type ModuleId, newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testDb } from '../../test/db.js';
import { addMember, ownerTx, seedTenant, seedUser, type Tenant } from '../../test/tenancy.js';
import type { Pools } from '../db/pools.js';
import { buildApp, type KeptApp } from './app.js';
import { locationOfMeter, locationOfPlace, locationOfThing, type ModuleLoader } from './modules.js';

// Task 16: module gating (engineering spec §7.6).

const db = await testDb();
const pools = db.pools as Pools;

const VISIBLE = newId();
const fakeLoader: ModuleLoader = async (_req, locationId) =>
  locationId === VISIBLE ? new Set<ModuleId>(['money']) : null;

async function appWith(loader?: ModuleLoader, userId?: () => string | null): Promise<KeptApp> {
  const app = await buildApp({
    env: { KEPT_PUBLIC_URL: 'http://kept.test' },
    pools,
    ...(loader ? { moduleLoader: loader } : {}),
  });
  if (userId) {
    // Stands in for task 17's session hook (the routes below are `auth: 'none'`, so the real
    // one leaves them alone).
    app.addHook('onRequest', async (req) => {
      const id = userId();
      req.scope = id ? { userId: id, mfa: false } : null;
    });
  }
  const handler = async () => ({ ok: true });
  app.get('/l/:locationId/money', { config: { auth: 'none', module: 'money' } }, handler);
  app.get('/l/:locationId/vehicles', { config: { auth: 'none', module: 'vehicles' } }, handler);
  app.post(
    '/vehicles',
    {
      config: { auth: 'none', module: 'vehicles' },
      schema: { body: z.object({ location_id: z.string() }) },
    },
    handler,
  );
  // Step 2: camelCase bodies and the query string name the location too.
  app.post(
    '/camel/vehicles',
    {
      config: { auth: 'none', module: 'vehicles' },
      schema: { body: z.object({ locationId: z.string() }) },
    },
    handler,
  );
  app.get('/query/vehicles', { config: { auth: 'none', module: 'vehicles' } }, handler);
  app.get(
    '/place/:id/money',
    { config: { auth: 'none', module: 'money', moduleLocation: locationOfPlace(pools) } },
    handler,
  );
  app.get(
    '/thing/:thingId/vehicles',
    {
      config: {
        auth: 'none',
        module: 'vehicles',
        moduleLocation: locationOfThing(pools, 'thingId'),
      },
    },
    handler,
  );
  app.get(
    '/meter/:id/money',
    { config: { auth: 'none', module: 'money', moduleLocation: locationOfMeter(pools) } },
    handler,
  );
  app.get('/l/:locationId/core', { config: { auth: 'none' } }, handler);
  app.get(
    '/things/:id',
    { config: { auth: 'none', module: 'vehicles', moduleLocation: async () => VISIBLE } },
    handler,
  );
  await app.ready();
  return app;
}

describe('module preHandler, with a fake loader', () => {
  let app: KeptApp;
  beforeAll(async () => {
    app = await appWith(fakeLoader);
  });
  afterAll(() => app.close());

  it('lets a request through when the module is on', async () => {
    const res = await app.inject({ method: 'GET', url: `/l/${VISIBLE}/money` });
    expect(res.statusCode).toBe(200);
  });

  it('answers a read of an off module with 404 module_off', async () => {
    const res = await app.inject({ method: 'GET', url: `/l/${VISIBLE}/vehicles` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'That feature is turned off for this location.',
      code: 'module_off',
    });
  });

  it('answers a write to an off module with 409 module_off, reading body.location_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vehicles',
      payload: { location_id: VISIBLE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('module_off');
  });

  it('reads body.locationId and query.locationId (step 2)', async () => {
    const camel = await app.inject({
      method: 'POST',
      url: '/camel/vehicles',
      payload: { locationId: VISIBLE },
    });
    expect([camel.statusCode, camel.json().code]).toEqual([409, 'module_off']);
    const query = await app.inject({ method: 'GET', url: `/query/vehicles?locationId=${VISIBLE}` });
    expect([query.statusCode, query.json().code]).toEqual([404, 'module_off']);
    const none = await app.inject({ method: 'GET', url: '/query/vehicles' });
    expect([none.statusCode, none.json().code]).toEqual([404, 'not_found']);
  });

  it("answers a location the user can't see with plain not_found, never module_off", async () => {
    for (const url of [`/l/${newId()}/money`, `/l/${newId()}/vehicles`, '/l/not-a-uuid/money']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toBe('not_found');
    }
  });

  it('leaves core routes alone', async () => {
    const res = await app.inject({ method: 'GET', url: `/l/${newId()}/core` });
    expect(res.statusCode).toBe(200);
  });

  it('uses a route’s own moduleLocation resolver', async () => {
    const res = await app.inject({ method: 'GET', url: `/things/${newId()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('module_off');
  });
});

describe('module preHandler, reading the database as the user', () => {
  let t: Tenant;
  let outsider: string;
  let viewer: string;
  let current: string | null = null;
  let app: KeptApp;

  beforeAll(async () => {
    await db.reset();
    t = await seedTenant(db, 'modules'); // preset household (the column default)
    outsider = await seedUser(db, 'modules-outsider');
    viewer = await seedUser(db, 'modules-viewer');
    await addMember(db, t.locationId, viewer, 'viewer');
    await ownerTx(db, async (c) => {
      // Household has vehicles; switch it off here. Consumables (Complete only) switched on.
      await c.query(
        `INSERT INTO public.location_modules (location_id, module, enabled)
         VALUES ($1, 'vehicles', false), ($1, 'consumables', true)`,
        [t.locationId],
      );
    });
    app = await appWith(undefined, () => current);
  });
  afterAll(() => app.close());

  const get = (path: string) => app.inject({ method: 'GET', url: `/l/${t.locationId}/${path}` });

  it('applies the preset and the location_modules rows', async () => {
    current = viewer;
    expect((await get('money')).statusCode).toBe(200);
    const vehicles = await get('vehicles');
    expect([vehicles.statusCode, vehicles.json().code]).toEqual([404, 'module_off']);
  });

  it('resolves a place, a thing and a meter to their location, as the user', async () => {
    const { thingId, meterId } = await ownerTx(db, async (c) => {
      const thing = newId();
      await c.query(
        'INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, $4)',
        [thing, t.locationId, t.unplacedId, 'Mower'],
      );
      const { rows } = await c.query(
        `INSERT INTO public.meters (location_id, thing_id, kind, unit)
         VALUES ($1, $2, 'hours', 'h') RETURNING id`,
        [t.locationId, thing],
      );
      return { thingId: thing, meterId: rows[0].id as string };
    });
    const at = (url: string) => app.inject({ method: 'GET', url });
    current = viewer;
    expect((await at(`/place/${t.unplacedId}/money`)).statusCode).toBe(200);
    expect((await at(`/meter/${meterId}/money`)).statusCode).toBe(200);
    const thing = await at(`/thing/${thingId}/vehicles`);
    expect([thing.statusCode, thing.json().code]).toEqual([404, 'module_off']);
    // Unknown ids, bad ids and rows the user can't see are all a plain 404.
    for (const url of [`/place/${newId()}/money`, '/place/nope/money', `/meter/${newId()}/money`]) {
      const res = await at(url);
      expect([res.statusCode, res.json().code], url).toEqual([404, 'not_found']);
    }
    current = outsider;
    const hidden = await at(`/place/${t.unplacedId}/money`);
    expect([hidden.statusCode, hidden.json().code]).toEqual([404, 'not_found']);
  });

  it("answers another user's location with not_found", async () => {
    current = outsider;
    const res = await get('money');
    expect([res.statusCode, res.json().code]).toEqual([404, 'not_found']);
  });

  it('needs a signed-in user', async () => {
    current = null;
    const res = await get('money');
    expect([res.statusCode, res.json().code]).toEqual([401, 'unauthenticated']);
  });
});
