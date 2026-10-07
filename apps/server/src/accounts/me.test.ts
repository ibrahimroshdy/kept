import { beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// GET /api/v1/me: the web shell's first query.

let db: TestDb;
let t: TestApp;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
});

describe('GET /api/v1/me', () => {
  it('answers with the user, preferences, the Personal location and every membership', async () => {
    const me = await person(t, db, 'me');
    const other = await person(t, db, 'other');
    const home = await call(t, '/api/v1/locations', {
      as: other,
      body: { name: 'Their home', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    const until = new Date(Date.now() + 86_400_000);
    await join(db, home.json().id, me.userId, 'viewer', until);

    const res = await call(t, '/api/v1/me', { as: me });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      user: {
        id: me.userId,
        displayName: me.email.split('@')[0],
        email: me.email,
        username: null,
        twoFactorEnabled: false,
        managed: false,
        instanceAdmin: false,
      },
      mfa: false,
      personalLocationId: me.personalLocationId,
      profile: {
        timezone: 'UTC',
        locale: 'en',
        units: 'metric',
        theme: 'system',
        digits: 'western',
        suggestLocation: false,
      },
      memberships: [
        {
          locationId: me.personalLocationId,
          name: 'Personal',
          kind: 'personal',
          role: 'owner',
          expiresAt: null,
        },
        {
          locationId: home.json().id,
          name: 'Their home',
          kind: 'home',
          role: 'viewer',
          expiresAt: until.toISOString(),
        },
      ],
      instance: { recoveryKitAcknowledged: null },
    });
  });

  it('says instance admin, and whether the recovery kit was acknowledged (admins only)', async () => {
    const me = await person(t, db, 'admin');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [me.userId]),
    );
    const body = (await call(t, '/api/v1/me', { as: me })).json();
    expect(body.user.instanceAdmin).toBe(true);
    expect(body.instance.recoveryKitAcknowledged).toBe(false);
  });

  it('hides a managed account’s synthetic email and shows its username', async () => {
    const me = await person(t, db, 'kid');
    await ownerTx(db, async (c) => {
      await c.query('UPDATE public.user_profiles SET managed = true WHERE user_id = $1', [
        me.userId,
      ]);
      await c.query(`UPDATE auth."user" SET username = 'kiddo' WHERE id = $1`, [me.userId]);
    });
    const body = (await call(t, '/api/v1/me', { as: me })).json();
    expect(body.user).toMatchObject({ email: null, username: 'kiddo', managed: true });
  });

  // catalogue: PATCH /api/v1/me
  it('PATCH keeps "Suggest where I am" on the person, across devices, and audits it (T19)', async () => {
    const me = await person(t, db, 'me');
    const on = await call(t, '/api/v1/me', {
      as: me,
      method: 'PATCH',
      body: { suggestLocation: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({ suggestLocation: true });
    const read = await call(t, '/api/v1/me', { as: me });
    expect(read.json().profile.suggestLocation).toBe(true);
    const events = await ownerTx(
      db,
      async (c) =>
        (
          await c.query<{ action: string; diff: unknown }>(
            `SELECT action, diff FROM public.audit_events WHERE actor_id = $1 AND action = 'me.preferences'`,
            [me.userId],
          )
        ).rows,
    );
    expect(events).toEqual([
      {
        action: 'me.preferences',
        diff: { suggest_location: { before: false, after: true, class: 'plain' } },
      },
    ]);
    // The same value again changes nothing and writes nothing.
    await call(t, '/api/v1/me', { as: me, method: 'PATCH', body: { suggestLocation: true } });
    expect(
      (
        await ownerTx(db, (c) =>
          c.query(
            `SELECT 1 FROM public.audit_events WHERE actor_id = $1 AND action = 'me.preferences'`,
            [me.userId],
          ),
        )
      ).rowCount,
    ).toBe(1);
    const bad = await call(t, '/api/v1/me', { as: me, method: 'PATCH', body: { theme: 'dark' } });
    expect(bad.statusCode).toBe(400);
  });

  it('needs a session', async () => {
    expect((await call(t, '/api/v1/me')).statusCode).toBe(401);
  });
});
