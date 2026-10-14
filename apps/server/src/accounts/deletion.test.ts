import { randomBytes } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { cookieHeader, requestHeaders } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, PASSWORD, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import type { BlobStore } from '../storage/blob-store.js';
import { runPurge } from '../trash/jobs.js';

// 1.2, D225: deleting your own account. What stops it, the re-authentication, the 30 days in
// which only /me and keeping it answer, keeping it, and the purge that deletes it for good.

let db: TestDb;
let t: TestApp;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
});

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

/** The account-level audit events of `p`, oldest first (as kept_owner). */
const accountAudit = (p: Person) =>
  own<{ action: string; diff: unknown }>(
    `SELECT e.action, e.diff FROM public.audit_events e
       JOIN public.owner_accounts oa ON oa.id = e.owner_account_id
      WHERE oa.user_id = $1 AND e.location_id IS NULL ORDER BY e.at, e.id`,
    [p.userId],
  );

const deletion = (p: Person, method: 'GET' | 'POST' | 'DELETE', body?: object) =>
  call(t, '/api/v1/me/deletion', { as: p, method, ...(body ? { body } : {}) });

const newHome = async (p: Person, name: string): Promise<string> => {
  const res = await call(t, '/api/v1/locations', {
    as: p,
    body: { name, kind: 'home', timezone: 'UTC', currency: 'USD' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
};

/** A second session for `p`, as another device would have. */
async function secondSession(p: Person): Promise<{ cookie: string }> {
  const { headers } = await t.auth.api.signInEmail({
    body: { email: p.email, password: PASSWORD },
    headers: requestHeaders(),
    returnHeaders: true,
  });
  return { cookie: cookieHeader(headers) };
}

describe('GET /api/v1/me/deletion', () => {
  it('says nothing stops a fresh account', async () => {
    const me = await person(t, db, 'me');
    const res = await deletion(me, 'GET');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      purgeAfter: null,
      blockers: { locations: [], lastInstanceAdmin: false, managed: false },
    });
  });

  it('names the locations it owns besides Personal, the last instance admin and a managed account', async () => {
    const me = await person(t, db, 'me');
    const home = await newHome(me, 'Home');
    const gone = await newHome(me, 'Old flat');
    await call(t, `/api/v1/locations/${gone}`, { as: me, method: 'DELETE' });
    await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [me.userId]);
    await own('UPDATE public.user_profiles SET managed = true WHERE user_id = $1', [me.userId]);

    const res = await deletion(me, 'GET');
    expect(res.json().blockers).toEqual({
      locations: [{ id: home, name: 'Home' }],
      lastInstanceAdmin: true,
      managed: true,
    });

    // A second admin who isn't leaving too lifts the admin block.
    const other = await person(t, db, 'other');
    await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [other.userId]);
    expect((await deletion(me, 'GET')).json().blockers.lastInstanceAdmin).toBe(false);
  });
});

describe('POST /api/v1/me/deletion', () => {
  it('refuses with the blockers before asking for the password, and writes nothing', async () => {
    const me = await person(t, db, 'me');
    const home = await newHome(me, 'Home');
    const res = await deletion(me, 'POST', {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('account_deletion_blocked');
    expect(res.json().blockers.locations).toEqual([{ id: home, name: 'Home' }]);
    expect(await own('SELECT 1 FROM auth.user_deletion WHERE user_id = $1', [me.userId])).toEqual(
      [],
    );
  });

  it('needs the password again', async () => {
    const me = await person(t, db, 'me');
    const missing = await deletion(me, 'POST', {});
    expect(missing.statusCode, missing.body).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'reauth_required', reauth: 'password' });
    const wrong = await deletion(me, 'POST', { password: 'not it at all' });
    expect(wrong.statusCode).toBe(403);
    expect(await own('SELECT 1 FROM auth.user_deletion WHERE user_id = $1', [me.userId])).toEqual(
      [],
    );
  });

  // catalogue: POST /api/v1/me/deletion
  it('starts 30 days: other sessions end, the address is mailed, only /me answers', async () => {
    const me = await person(t, db, 'me');
    const elsewhere = await secondSession(me);
    expect((await call(t, '/api/v1/locations', { as: elsewhere })).statusCode).toBe(200);

    const before = Date.now();
    const res = await deletion(me, 'POST', { password: PASSWORD });
    expect(res.statusCode, res.body).toBe(202);
    const purgeAfter = Date.parse(res.json().purgeAfter);
    const days = (purgeAfter - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);

    expect(await accountAudit(me)).toEqual([
      { action: 'account.deletion_request', diff: expect.anything() },
    ]);
    expect(t.mail).toContainEqual(
      expect.objectContaining({ kind: 'account-deletion', to: me.email, timezone: 'UTC' }),
    );
    // The other device is signed out; this one sees only /me and the deletion routes.
    expect((await call(t, '/api/v1/me', { as: elsewhere })).statusCode).toBe(401);
    const blocked = await call(t, '/api/v1/locations', { as: me });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      code: 'account_deletion_pending',
      purgeAfter: res.json().purgeAfter,
    });
    const meNow = await call(t, '/api/v1/me', { as: me });
    expect(meNow.statusCode).toBe(200);
    expect(meNow.json().deletion).toEqual({ purgeAfter: res.json().purgeAfter });
    expect((await deletion(me, 'GET')).json().purgeAfter).toBe(res.json().purgeAfter);
    // Signing in again during the 30 days gives the same narrow session.
    const again = await secondSession(me);
    expect((await call(t, '/api/v1/locations', { as: again })).statusCode).toBe(403);
    expect((await call(t, '/api/v1/me', { as: again })).json().deletion).not.toBeNull();
  });
});

describe('DELETE /api/v1/me/deletion', () => {
  // catalogue: DELETE /api/v1/me/deletion
  it('keeps the account: everything answers again', async () => {
    const me = await person(t, db, 'me');
    await deletion(me, 'POST', { password: PASSWORD });
    const res = await deletion(me, 'DELETE');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ purgeAfter: null });
    expect((await accountAudit(me)).map((e) => e.action)).toEqual([
      'account.deletion_request',
      'account.deletion_cancel',
    ]);
    expect((await call(t, '/api/v1/locations', { as: me })).statusCode).toBe(200);
    expect((await call(t, '/api/v1/me', { as: me })).json().deletion).toBeNull();
  });
});

describe('the purge (D225)', () => {
  const deleted: string[] = [];
  const blobs = {
    delete: async (key: string) => void deleted.push(key),
  } as unknown as BlobStore;
  const log = { info: () => {}, error: () => {} };
  const purge = () => runPurge({ pools: db.pools, log, blobs });
  const due = (p: Person) =>
    own(
      `UPDATE auth.user_deletion SET purge_after = now() - interval '1 minute' WHERE user_id = $1`,
      [p.userId],
    );

  async function storedFile(locationId: string, userId: string): Promise<string> {
    const id = newId();
    const key = `f/${locationId}/${id}`;
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 64, 'application/pdf', 'document', 'not_applicable', $5)`,
      [id, locationId, key, randomBytes(32).toString('hex'), userId],
    );
    return key;
  }

  it('deletes an account past its date: its Personal location, files, memberships and sign-in', async () => {
    deleted.length = 0;
    const me = await person(t, db, 'me');
    const friend = await person(t, db, 'friend');
    const theirs = await newHome(friend, 'Their home');
    await join(db, theirs, me.userId, 'member');
    const key = await storedFile(me.personalLocationId, me.userId);
    // Something I added to their home stays theirs.
    const unplaced = (
      await own<{ id: string }>(
        `SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced`,
        [theirs],
      )
    )[0]?.id;
    const thing = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name, created_by)
       VALUES ($1, $2, $3, 'Ladder', $4)`,
      [thing, theirs, unplaced, me.userId],
    );

    await deletion(me, 'POST', { password: PASSWORD });
    // Not yet due: nothing happens.
    expect((await purge()).accounts).toBe(0);
    await due(me);
    const report = await purge();
    expect(report.accounts).toBe(1);
    expect(deleted).toContain(key);

    expect(await own('SELECT 1 FROM auth."user" WHERE id = $1', [me.userId])).toEqual([]);
    expect(
      await own('SELECT 1 FROM public.locations WHERE id = $1', [me.personalLocationId]),
    ).toEqual([]);
    expect(await own('SELECT 1 FROM public.memberships WHERE user_id = $1', [me.userId])).toEqual(
      [],
    );
    expect(await own('SELECT 1 FROM public.user_profiles WHERE user_id = $1', [me.userId])).toEqual(
      [],
    );
    expect(await own('SELECT name FROM public.things WHERE id = $1', [thing])).toEqual([
      { name: 'Ladder' },
    ]);
    // The friend's account is untouched.
    expect((await call(t, '/api/v1/locations', { as: friend })).statusCode).toBe(200);
  });

  it('waits while the account came to own a live location meanwhile', async () => {
    const me = await person(t, db, 'me');
    await deletion(me, 'POST', { password: PASSWORD });
    // An operator's transfer (kept admin transfer-ownership) gives it a home after it asked.
    const friend = await person(t, db, 'friend');
    const home = await newHome(friend, 'Home');
    await ownerTx(db, async (c) => {
      await c.query(
        `UPDATE public.locations SET owner_account_id =
           (SELECT id FROM public.owner_accounts WHERE user_id = $1) WHERE id = $2`,
        [me.userId, home],
      );
      await c.query(
        `UPDATE public.memberships SET user_id = $1 WHERE location_id = $2 AND role = 'owner'`,
        [me.userId, home],
      );
    });
    await due(me);
    expect((await purge()).accounts).toBe(0);
    expect(await own('SELECT 1 FROM auth."user" WHERE id = $1', [me.userId])).toHaveLength(1);
  });
});
