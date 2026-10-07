import { newId, presetModules } from '@kept/shared';
import { v7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// Task 19: locations through the front door (app.inject, signed-in cookies), as the web app
// calls them.

let db: TestDb;
let t: TestApp;
let owner: Person;

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Home',
  kind: 'home',
  preset: 'essentials',
  timezone: 'Africa/Cairo',
  currency: 'EGP',
  rooms: ['Kitchen', 'Garage', 'Kitchen'],
  ...overrides,
});

async function create(as: Person, overrides: Record<string, unknown> = {}) {
  const res = await call(t, '/api/v1/locations', { as, body: body(overrides) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; rowVersion: number } & Record<string, unknown>;
}

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  owner = await person(t, db, 'owner');
});

describe('POST /api/v1/locations', () => {
  // catalogue: POST /api/v1/locations
  it('creates the location with its owner membership, Unplaced area, rooms, modules and event', async () => {
    const loc = await create(owner);
    expect(loc).toMatchObject({
      name: 'Home',
      kind: 'home',
      role: 'owner',
      preset: 'essentials',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      memberCount: 1,
      pendingInviteCount: 0,
      modules: [...presetModules('essentials')],
      // The AI modules need a provider (D191): switched on, not effective.
      effectiveModules: ['labels'],
      providerResolved: false,
      rowVersion: 1,
    });
    const places = await ownerTx(db, (c) =>
      c.query('SELECT name, is_unplaced FROM public.places WHERE location_id = $1 ORDER BY name', [
        loc.id,
      ]),
    );
    expect(places.rows).toEqual([
      { name: 'Garage', is_unplaced: false },
      { name: 'Kitchen', is_unplaced: false },
      { name: 'Unplaced', is_unplaced: true },
    ]);
    const switches = await ownerTx(db, (c) =>
      c.query(
        'SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS on FROM public.location_modules WHERE location_id = $1',
        [loc.id],
      ),
    );
    expect(switches.rows[0]).toEqual({ n: 14, on: presetModules('essentials').size });
    expect(await auditOf(db, loc.id)).toEqual([
      expect.objectContaining({
        action: 'location.create',
        actor_type: 'user',
        actor_id: owner.userId,
      }),
    ]);
  });

  it('takes a client id in the UUIDv7 window, and refuses one outside it', async () => {
    const id = newId();
    expect((await create(owner, { id })).id).toBe(id);
    const old = v7({ msecs: Date.now() - 30 * 86_400_000 });
    const res = await call(t, '/api/v1/locations', { as: owner, body: body({ id: old }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('id_out_of_window');
  });

  it('refuses a Personal kind, an unknown currency and an unknown time zone', async () => {
    for (const bad of [{ kind: 'personal' }, { currency: 'XXX' }, { timezone: 'Mars/Base' }]) {
      const res = await call(t, '/api/v1/locations', { as: owner, body: body(bad) });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('refuses a managed account (D47, D114)', async () => {
    await ownerTx(db, (c) =>
      c.query('UPDATE public.user_profiles SET managed = true WHERE user_id = $1', [owner.userId]),
    );
    const res = await call(t, '/api/v1/locations', { as: owner, body: body() });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
  });

  it('runs once per Idempotency-Key and replays the answer', async () => {
    const headers = { 'idempotency-key': 'create-home-1' };
    const first = await call(t, '/api/v1/locations', { as: owner, body: body(), headers });
    const again = await call(t, '/api/v1/locations', { as: owner, body: body(), headers });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    const other = await call(t, '/api/v1/locations', {
      as: owner,
      body: body({ name: 'Cabin' }),
      headers,
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('idempotency_mismatch');
  });

  it('needs a session', async () => {
    expect((await call(t, '/api/v1/locations', { body: body() })).statusCode).toBe(401);
  });
});

describe('GET /api/v1/locations and /:id', () => {
  it("lists the caller's locations with their role, and hides them from everyone else", async () => {
    const home = await create(owner);
    const viewer = await person(t, db, 'viewer');
    await join(db, home.id, viewer.userId, 'viewer');

    const mine = (await call(t, '/api/v1/locations', { as: owner })).json().locations;
    expect(mine.map((l: { kind: string; role: string }) => [l.kind, l.role])).toEqual([
      ['personal', 'owner'],
      ['home', 'owner'],
    ]);
    expect(mine[1]).toMatchObject({ memberCount: 2, effectiveModules: ['labels'] });

    const theirs = (await call(t, '/api/v1/locations', { as: viewer })).json().locations;
    expect(theirs.map((l: { id: string; role: string }) => [l.id, l.role])).toEqual([
      [viewer.personalLocationId, 'owner'],
      [home.id, 'viewer'],
    ]);

    const outsider = await person(t, db, 'outsider');
    expect((await call(t, `/api/v1/locations/${home.id}`, { as: outsider })).statusCode).toBe(404);
    expect((await call(t, `/api/v1/locations/${home.id}`, { as: viewer })).json().role).toBe(
      'viewer',
    );
  });

  it('counts the live things of each location, trashed ones left out', async () => {
    const home = await create(owner);
    const unplaced = await ownerTx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
        [home.id],
      );
      return rows[0]?.id as string;
    });
    for (const name of ['Drill', 'Saw', 'Hammer']) {
      const res = await call(t, '/api/v1/things', {
        as: owner,
        body: { locationId: home.id, placeId: unplaced, name },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.things SET deleted_at = now() WHERE location_id = $1 AND name = 'Saw'`,
        [home.id],
      ),
    );

    const list = (await call(t, '/api/v1/locations', { as: owner })).json().locations;
    expect(list.map((l: { kind: string; thingCount: number }) => [l.kind, l.thingCount])).toEqual([
      ['personal', 0],
      ['home', 2],
    ]);
    const one = await call(t, `/api/v1/locations/${home.id}`, { as: owner });
    expect(one.json().thingCount).toBe(2);
  });
});

describe('PATCH /api/v1/locations/:id', () => {
  let home: { id: string; rowVersion: number };
  let admin: Person;
  let member: Person;

  beforeEach(async () => {
    home = await create(owner);
    admin = await person(t, db, 'admin');
    member = await person(t, db, 'member');
    await join(db, home.id, admin.userId, 'admin');
    await join(db, home.id, member.userId, 'member');
  });

  const patch = (as: Person, payload: unknown, ifMatch?: string | number) =>
    call(t, `/api/v1/locations/${home.id}`, {
      method: 'PATCH',
      as,
      body: payload,
      ...(ifMatch !== undefined ? { headers: { 'if-match': String(ifMatch) } } : {}),
    });

  // catalogue: PATCH /api/v1/locations/:id
  it('lets an admin change settings with If-Match, and audits the change', async () => {
    const res = await patch(admin, { name: 'The flat', currency: 'usd' }, home.rowVersion);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'The flat', currency: 'USD', rowVersion: 2 });
    const events = await auditOf(db, home.id);
    expect(events.at(-1)).toMatchObject({
      action: 'location.update',
      actor_id: admin.userId,
      diff: {
        name: { before: 'Home', after: 'The flat', class: 'plain' },
        currency: { before: 'EGP', after: 'USD', class: 'plain' },
      },
    });
  });

  it('needs If-Match (428), refuses a stale version (412), and a member (403)', async () => {
    expect((await patch(admin, { name: 'x' })).statusCode).toBe(428);
    await patch(admin, { name: 'first' }, home.rowVersion);
    const stale = await patch(admin, { name: 'second' }, home.rowVersion);
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ conflicts: ['name'], row_version: 2 });
    expect((await patch(member, { name: 'x' }, 2)).statusCode).toBe(403);
  });

  it("keeps require_2fa and the successor the owner's (§7.14, D165)", async () => {
    expect((await patch(admin, { require2fa: true }, 1)).statusCode).toBe(403);
    expect((await patch(admin, { successorUserId: admin.userId }, 1)).statusCode).toBe(403);
    // The owner without a second factor would hide the location from their own session.
    const hidden = await patch(owner, { require2fa: true }, 1);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().code).toBe('mfa_required');
    const named = await patch(owner, { successorUserId: admin.userId }, 1);
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().successorUserId).toBe(admin.userId);
    // Only a current member can be named.
    const outsider = await person(t, db, 'outsider');
    expect((await patch(owner, { successorUserId: outsider.userId }, 2)).statusCode).toBe(404);
  });
});

describe('DELETE and restore', () => {
  // catalogue: DELETE /api/v1/locations/:id
  // catalogue: POST /api/v1/locations/:id/restore
  it('lets only the owner delete, never Personal, and restore within the grace period', async () => {
    const home = await create(owner);
    const admin = await person(t, db, 'admin');
    await join(db, home.id, admin.userId, 'admin');

    expect(
      (await call(t, `/api/v1/locations/${home.id}`, { method: 'DELETE', as: admin })).statusCode,
    ).toBe(403);
    const personal = await call(t, `/api/v1/locations/${owner.personalLocationId}`, {
      method: 'DELETE',
      as: owner,
    });
    expect(personal.statusCode).toBe(409);

    const del = await call(t, `/api/v1/locations/${home.id}`, { method: 'DELETE', as: owner });
    expect(del.statusCode, del.body).toBe(200);
    const purgeAfter = new Date(del.json().purgeAfter).getTime();
    expect(purgeAfter - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // Gone for everyone at once (D149).
    expect((await call(t, `/api/v1/locations/${home.id}`, { as: admin })).statusCode).toBe(404);
    expect((await call(t, `/api/v1/locations/${home.id}`, { as: owner })).statusCode).toBe(404);
    const deleted = (await call(t, '/api/v1/locations/deleted', { as: owner })).json().locations;
    expect(deleted.map((l: { id: string }) => l.id)).toEqual([home.id]);
    expect((await call(t, '/api/v1/locations/deleted', { as: admin })).json().locations).toEqual(
      [],
    );

    expect(
      (
        await call(t, `/api/v1/locations/${home.id}/restore`, {
          method: 'POST',
          as: admin,
          body: {},
        })
      ).statusCode,
    ).toBe(404);
    const restored = await call(t, `/api/v1/locations/${home.id}/restore`, {
      as: owner,
      body: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await auditOf(db, home.id)).map((e) => e.action)).toEqual([
      'location.create',
      'location.delete',
      'location.restore',
    ]);
  });
});

describe('POST /api/v1/locations/:id/modules', () => {
  // catalogue: POST /api/v1/locations/:id/modules
  it('toggles one module or sets the whole state, admins and above', async () => {
    const home = await create(owner, { preset: 'household' });
    const viewer = await person(t, db, 'viewer');
    await join(db, home.id, viewer.userId, 'viewer');
    const url = `/api/v1/locations/${home.id}/modules`;

    expect(
      (await call(t, url, { as: viewer, body: { module: 'money', enabled: false } })).statusCode,
    ).toBe(403);

    const off = await call(t, url, { as: owner, body: { module: 'money', enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().modules).not.toContain('money');

    const full = await call(t, url, {
      as: owner,
      body: { preset: 'complete', modules: ['labels', 'fuel'] },
    });
    expect(full.json()).toMatchObject({ preset: 'complete', modules: ['labels', 'fuel'] });
    // Fuel needs Vehicles (D191): switched on, not in effect.
    expect(full.json().effectiveModules).toEqual(['labels']);
    expect((await auditOf(db, home.id)).map((e) => e.action)).toEqual([
      'location.create',
      'location.modules',
      'location.modules',
    ]);
  });
});

describe('security review of tasks 19–21', () => {
  it('pages the location list and the deleted list (§7.7, M8)', async () => {
    for (const name of ['Beta', 'alpha', 'Gamma']) await create(owner, { name, rooms: [] });
    const first = await call(t, '/api/v1/locations?limit=2', { as: owner });
    expect(first.statusCode, first.body).toBe(200);
    // Personal first, then by name.
    expect(first.json().locations.map((l: { name: string }) => l.name)).toEqual([
      'Personal',
      'alpha',
    ]);
    const cursor = first.json().nextCursor as string;
    const second = await call(t, `/api/v1/locations?limit=2&cursor=${cursor}`, { as: owner });
    expect(second.json().locations.map((l: { name: string }) => l.name)).toEqual(['Beta', 'Gamma']);
    expect(second.json().nextCursor).toBeNull();
    const bad = await call(t, '/api/v1/locations?cursor=bm9wZQ', { as: owner });
    expect(bad.statusCode).toBe(400);

    const all = [...first.json().locations, ...second.json().locations].filter(
      (l: { kind: string }) => l.kind !== 'personal',
    );
    for (const l of all) {
      expect(
        (await call(t, `/api/v1/locations/${l.id}`, { method: 'DELETE', as: owner })).statusCode,
      ).toBe(200);
    }
    const d1 = await call(t, '/api/v1/locations/deleted?limit=2', { as: owner });
    expect(d1.json().locations).toHaveLength(2);
    const d2 = await call(t, `/api/v1/locations/deleted?limit=2&cursor=${d1.json().nextCursor}`, {
      as: owner,
    });
    expect(d2.json().locations).toHaveLength(1);
    expect(d2.json().nextCursor).toBeNull();
    const names = [...d1.json().locations, ...d2.json().locations].map(
      (l: { name: string }) => l.name,
    );
    expect(names.sort()).toEqual(['Beta', 'Gamma', 'alpha']);
  });

  it('lets one of two racing edits with the same If-Match through, and 412s the other (M2)', async () => {
    const loc = await create(owner);
    const edit = (name: string) =>
      call(t, `/api/v1/locations/${loc.id}`, {
        method: 'PATCH',
        as: owner,
        body: { name },
        headers: { 'if-match': String(loc.rowVersion) },
      });
    const answers = await Promise.all([edit('One'), edit('Two'), edit('Three')]);
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 412, 412]);
  });

  it("moves the location's row_version when a module is switched (M2)", async () => {
    const loc = await create(owner);
    const res = await call(t, `/api/v1/locations/${loc.id}/modules`, {
      as: owner,
      body: { module: 'money', enabled: true },
      headers: { 'if-match': String(loc.rowVersion) },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rowVersion).toBe(loc.rowVersion + 1);
    const stale = await call(t, `/api/v1/locations/${loc.id}/modules`, {
      as: owner,
      body: { module: 'money', enabled: false },
      headers: { 'if-match': String(loc.rowVersion) },
    });
    expect(stale.statusCode).toBe(412);
  });
});
