import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { enrolTotp } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, PASSWORD, type Person, peopleApp, person } from '../../test/people.js';
import { asOwner, ownerTx } from '../../test/tenancy.js';
import { allowPrivateAddresses } from '../ai/runtime.js';

// Task 23: instance admin routes (D164, D165, D180, §7.11, §7.14), through the front door.

let db: TestDb;
let t: TestApp;
let admin: Person;
let bob: Person;

async function makeInstanceAdmin(userId: string) {
  await ownerTx(db, (c) =>
    c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [userId]),
  );
}

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  admin = await person(t, db, 'admin');
  bob = await person(t, db, 'bob');
  await makeInstanceAdmin(admin.userId);
});

const instanceAudit = () =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{ action: string; actor_id: string; entity_id: string }>(
      `SELECT action, actor_id, entity_id FROM public.audit_events
        WHERE location_id IS NULL AND owner_account_id IS NULL ORDER BY at, id`,
    );
    return rows;
  });

const adminMail = () => t.mail.filter((m) => m.kind === 'admin-action');

async function signIn(email: string) {
  return call(t, '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } });
}

describe('the admin gate', () => {
  it('401 without a session, 403 for anyone but an instance admin', async () => {
    expect((await call(t, '/api/v1/admin/users')).statusCode).toBe(401);
    const res = await call(t, '/api/v1/admin/users', { as: bob });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
    expect(
      (await call(t, `/api/v1/admin/users/${admin.userId}/disable`, { as: bob, body: {} }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(t, '/api/v1/admin/settings', { as: bob, method: 'PUT', body: {} })).statusCode,
    ).toBe(403);
  });
});

describe('GET /api/v1/admin/users', () => {
  it('lists users with their role counts, searchable and paged', async () => {
    const home = await call(t, '/api/v1/locations', {
      as: bob,
      body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    await join(db, home.json().id, admin.userId, 'viewer');

    const all = await call(t, '/api/v1/admin/users', { as: admin });
    expect(all.statusCode).toBe(200);
    const { users, nextCursor } = all.json() as {
      users: { id: string; email: string; instanceAdmin: boolean; roles: object }[];
      nextCursor: string | null;
    };
    expect(nextCursor).toBeNull();
    expect(users.map((u) => u.id)).toEqual([admin.userId, bob.userId]);
    expect(users[0]).toMatchObject({
      email: admin.email,
      displayName: expect.any(String),
      instanceAdmin: true,
      managed: false,
      disabled: false,
      twoFactorEnabled: false,
      roles: { owner: 1, admin: 0, member: 0, viewer: 1 },
    });
    expect(users[1]).toMatchObject({ instanceAdmin: false, roles: { owner: 2 } });

    const found = await call(t, `/api/v1/admin/users?q=${encodeURIComponent('bob-')}`, {
      as: admin,
    });
    expect(found.json().users.map((u: { id: string }) => u.id)).toEqual([bob.userId]);
    // `%` is matched literally, not as a wildcard.
    expect((await call(t, '/api/v1/admin/users?q=%25', { as: admin })).json().users).toEqual([]);

    const first = await call(t, '/api/v1/admin/users?limit=1', { as: admin });
    expect(first.json().users).toHaveLength(1);
    const second = await call(t, `/api/v1/admin/users?limit=1&cursor=${first.json().nextCursor}`, {
      as: admin,
    });
    expect(second.json()).toEqual({
      users: [expect.objectContaining({ id: bob.userId })],
      nextCursor: null,
    });
  });
});

describe('GET /api/v1/admin/accounts (T19: the AI cap override picker)', () => {
  it('lists accounts by owner name with their location counts, names only, admins only', async () => {
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.user_profiles SET display_name = CASE user_id
           WHEN $1::uuid THEN 'Ibrahim' WHEN $2::uuid THEN 'Bruce' END
          WHERE user_id IN ($1, $2)`,
        [admin.userId, bob.userId],
      ),
    );
    const home = await call(t, '/api/v1/locations', {
      as: bob,
      body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    expect(home.statusCode).toBe(201);
    const res = await call(t, '/api/v1/admin/accounts', { as: admin });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as { id: string; ownerName: string; locations: number }[];
    expect(items.map((i) => [i.ownerName, i.locations])).toEqual([
      ['Bruce', 2],
      ['Ibrahim', 1],
    ]);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(['id', 'locations', 'ownerName']);
    const found = await call(t, '/api/v1/admin/accounts?q=bru', { as: admin });
    expect(found.json().items.map((i: { ownerName: string }) => i.ownerName)).toEqual(['Bruce']);
    expect((await call(t, '/api/v1/admin/accounts', { as: bob })).statusCode).toBe(403);
  });
});

describe('actions on an account (D165), each audited and mailed (D180)', () => {
  // catalogue: POST /api/v1/admin/users/:id/disable
  // catalogue: POST /api/v1/admin/users/:id/enable
  it('disable: signs them out and refuses sign-in; enable lets them back', async () => {
    const res = await call(t, `/api/v1/admin/users/${bob.userId}/disable`, { as: admin, body: {} });
    expect(res.statusCode).toBe(204);
    expect((await call(t, '/api/v1/me', { as: bob })).statusCode).toBe(401);
    expect((await signIn(bob.email)).statusCode).toBe(403);
    await vi.waitFor(
      () =>
        expect(adminMail()).toEqual([{ kind: 'admin-action', to: bob.email, action: 'disabled' }]),
      { timeout: 10_000 },
    );
    expect(await instanceAudit()).toEqual([
      { action: 'admin.user_disable', actor_id: admin.userId, entity_id: bob.userId },
    ]);
    const listed = (await call(t, '/api/v1/admin/users', { as: admin })).json().users;
    expect(listed.find((u: { id: string }) => u.id === bob.userId).disabled).toBe(true);

    expect(
      (await call(t, `/api/v1/admin/users/${bob.userId}/enable`, { as: admin, body: {} }))
        .statusCode,
    ).toBe(204);
    expect((await signIn(bob.email)).statusCode).toBe(200);
    expect((await instanceAudit()).map((e) => e.action)).toEqual([
      'admin.user_disable',
      'admin.user_enable',
    ]);
  });

  it('refuses to disable yourself, and 404s an unknown user', async () => {
    const self = await call(t, `/api/v1/admin/users/${admin.userId}/disable`, {
      as: admin,
      body: {},
    });
    expect(self.statusCode).toBe(409);
    expect(
      (await call(t, `/api/v1/admin/users/${randomUUID()}/disable`, { as: admin, body: {} }))
        .statusCode,
    ).toBe(404);
    expect(await instanceAudit()).toEqual([]);
  });

  // catalogue: POST /api/v1/admin/users/:id/reset-2fa
  it('reset-2fa: clears TOTP and backup codes and signs out', async () => {
    await enrolTotp(t.auth, bob, PASSWORD);
    const res = await call(t, `/api/v1/admin/users/${bob.userId}/reset-2fa`, {
      as: admin,
      body: {},
    });
    expect(res.statusCode).toBe(204);
    const rows = await asOwner(db, (c) =>
      c.query(
        `SELECT u.two_factor_enabled, (SELECT count(*)::int FROM auth.two_factor f WHERE f.user_id = u.id) AS n,
                (SELECT count(*)::int FROM auth.session s WHERE s.user_id = u.id) AS sessions
           FROM auth."user" u WHERE u.id = $1`,
        [bob.userId],
      ),
    );
    expect(rows.rows[0]).toEqual({ two_factor_enabled: false, n: 0, sessions: 0 });
    // A plain password sign-in works again, with no challenge.
    const back = await signIn(bob.email);
    expect(back.json()).not.toHaveProperty('twoFactorRedirect');
    await vi.waitFor(
      () =>
        expect(adminMail()).toEqual([
          { kind: 'admin-action', to: bob.email, action: 'two-factor-reset' },
        ]),
      { timeout: 10_000 },
    );
    expect(await instanceAudit()).toEqual([
      { action: 'admin.user_reset_2fa', actor_id: admin.userId, entity_id: bob.userId },
    ]);
  });

  // catalogue: POST /api/v1/admin/users/:id/sign-out-everywhere
  it('sign-out-everywhere: every session ends; your own is not mailed about', async () => {
    const res = await call(t, `/api/v1/admin/users/${bob.userId}/sign-out-everywhere`, {
      as: admin,
      body: {},
    });
    expect(res.statusCode).toBe(204);
    expect((await call(t, '/api/v1/me', { as: bob })).statusCode).toBe(401);
    const self = await call(t, `/api/v1/admin/users/${admin.userId}/sign-out-everywhere`, {
      as: admin,
      body: {},
    });
    expect(self.statusCode).toBe(204);
    expect((await call(t, '/api/v1/me', { as: admin })).statusCode).toBe(401);
    await vi.waitFor(() => expect(adminMail()).toHaveLength(1), { timeout: 10_000 });
    expect(adminMail()[0]).toMatchObject({ to: bob.email, action: 'signed-out-everywhere' });
    expect((await instanceAudit()).map((e) => e.action)).toEqual([
      'admin.user_sign_out_everywhere',
      'admin.user_sign_out_everywhere',
    ]);
  });
});

describe('settings: sign-up (D127, §7.11)', () => {
  const signUp = () =>
    call(t, '/api/v1/auth/sign-up', {
      body: { email: `new-${randomUUID()}@example.com`, password: PASSWORD, displayName: 'New' },
    });

  // catalogue: PUT /api/v1/admin/settings
  it('opens and closes sign-up, audited', async () => {
    expect((await call(t, '/api/v1/admin/settings', { as: admin })).json()).toMatchObject({
      signupOpen: { value: false, locked: false },
    });
    expect((await signUp()).statusCode).toBe(403);
    const opened = await call(t, '/api/v1/admin/settings', {
      as: admin,
      method: 'PUT',
      body: { signupOpen: true },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ signupOpen: { value: true, locked: false } });
    expect((await signUp()).statusCode).toBe(202);
    const actions = (await instanceAudit()).map((e) => e.action);
    expect(actions).toEqual(['instance.settings_update']);
    // The same value again changes nothing and writes nothing.
    await call(t, '/api/v1/admin/settings', {
      as: admin,
      method: 'PUT',
      body: { signupOpen: true },
    });
    expect(await instanceAudit()).toHaveLength(1);
  });

  it('shows an environment-set value as locked and refuses to change it', async () => {
    const envT = await peopleApp(db, { signupOpenEnv: true });
    const asEnv = (url: string, opts: Parameters<typeof call>[2] = {}) => call(envT, url, opts);
    expect((await asEnv('/api/v1/admin/settings', { as: admin })).json()).toMatchObject({
      signupOpen: { value: true, locked: true },
    });
    const refused = await asEnv('/api/v1/admin/settings', {
      as: admin,
      method: 'PUT',
      body: { signupOpen: false },
    });
    expect(refused.statusCode).toBe(409);
    const open = await asEnv('/api/v1/auth/sign-up', {
      body: { email: `env-${randomUUID()}@example.com`, password: PASSWORD, displayName: 'E' },
    });
    expect(open.statusCode).toBe(202);
    await envT.app.close();
  });
});

describe('settings: private addresses (Q9, D83)', () => {
  const auditOfSettings = () =>
    asOwner(db, async (c) => {
      const { rows } = await c.query<{ diff: unknown }>(
        `SELECT diff FROM public.audit_events
          WHERE action = 'instance.settings_update' ORDER BY at, id`,
      );
      return rows;
    });

  it('is off by default; an instance admin turns it on and off, audited, and the AI layer reads it', async () => {
    expect((await call(t, '/api/v1/admin/settings', { as: admin })).json()).toMatchObject({
      ssrfAllowPrivate: false,
    });
    expect(await allowPrivateAddresses(db.pools)).toBe(false);

    const on = await call(t, '/api/v1/admin/settings', {
      as: admin,
      method: 'PUT',
      body: { ssrfAllowPrivate: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ ssrfAllowPrivate: true });
    expect(await allowPrivateAddresses(db.pools)).toBe(true);
    expect(await auditOfSettings()).toMatchObject([
      { diff: { ssrf_allow_private: { before: false, after: true } } },
    ]);

    await call(t, '/api/v1/admin/settings', {
      as: admin,
      method: 'PUT',
      body: { ssrfAllowPrivate: false },
    });
    expect(await allowPrivateAddresses(db.pools)).toBe(false);
    expect(await auditOfSettings()).toHaveLength(2);
  });

  it('is refused to anyone but an instance admin, and takes only a boolean', async () => {
    const res = await call(t, '/api/v1/admin/settings', {
      as: bob,
      method: 'PUT',
      body: { ssrfAllowPrivate: true },
    });
    expect(res.statusCode).toBe(403);
    expect(await allowPrivateAddresses(db.pools)).toBe(false);
    const bad = await call(t, '/api/v1/admin/settings', {
      as: admin,
      method: 'PUT',
      body: { ssrfAllowPrivate: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('instance admins', () => {
  // catalogue: POST /api/v1/admin/instance-admins
  // catalogue: DELETE /api/v1/admin/instance-admins/:id
  it('grants and revokes, mailing the person; the last one stays', async () => {
    const granted = await call(t, '/api/v1/admin/instance-admins', {
      as: admin,
      body: { userId: bob.userId },
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json()).toEqual({ userId: bob.userId, grantedAt: expect.any(String) });
    expect((await call(t, '/api/v1/me', { as: bob })).json().user.instanceAdmin).toBe(true);
    expect(
      (await call(t, '/api/v1/admin/instance-admins', { as: admin, body: { userId: bob.userId } }))
        .statusCode,
    ).toBe(409);

    // Bob removes admin; then bob can't remove himself, the last one.
    const revoked = await call(t, `/api/v1/admin/instance-admins/${admin.userId}`, {
      as: bob,
      method: 'DELETE',
    });
    expect(revoked.statusCode).toBe(204);
    const last = await call(t, `/api/v1/admin/instance-admins/${bob.userId}`, {
      as: bob,
      method: 'DELETE',
    });
    expect(last.statusCode).toBe(409);
    expect(last.json()).toMatchObject({ code: 'conflict' });
    expect(
      (
        await call(t, `/api/v1/admin/instance-admins/${admin.userId}`, {
          as: bob,
          method: 'DELETE',
        })
      ).statusCode,
    ).toBe(404);

    await vi.waitFor(
      () =>
        expect(adminMail()).toEqual([
          { kind: 'admin-action', to: bob.email, action: 'instance-admin-granted' },
          { kind: 'admin-action', to: admin.email, action: 'instance-admin-revoked' },
        ]),
      { timeout: 10_000 },
    );
    expect((await instanceAudit()).map((e) => e.action)).toEqual([
      'admin.instance_admin_grant',
      'admin.instance_admin_revoke',
    ]);
  });

  it('refuses a managed account and an unknown user', async () => {
    const home = await call(t, '/api/v1/locations', {
      as: admin,
      body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    const kid = await call(t, `/api/v1/locations/${home.json().id}/managed-accounts`, {
      as: admin,
      body: { displayName: 'Kid', username: `kid_${randomUUID().slice(0, 8)}`, role: 'member' },
    });
    const managed = await call(t, '/api/v1/admin/instance-admins', {
      as: admin,
      body: { userId: kid.json().userId },
    });
    expect(managed.statusCode).toBe(409);
    const unknown = await call(t, '/api/v1/admin/instance-admins', {
      as: admin,
      body: { userId: randomUUID() },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('the recovery-kit acknowledgement (D193)', () => {
  // catalogue: POST /api/v1/admin/recovery-kit/acknowledge
  it('is recorded once, audited, and shows on /me', async () => {
    expect((await call(t, '/api/v1/admin/recovery-kit', { as: admin })).json()).toEqual({
      acknowledgedAt: null,
      downloadedAt: null,
      stale: false,
    });
    const acked = await call(t, '/api/v1/admin/recovery-kit/acknowledge', { as: admin, body: {} });
    expect(acked.statusCode).toBe(200);
    const at = acked.json().acknowledgedAt;
    expect(at).toEqual(expect.any(String));
    const again = await call(t, '/api/v1/admin/recovery-kit/acknowledge', { as: admin, body: {} });
    expect(again.json()).toEqual({ acknowledgedAt: at });
    expect((await call(t, '/api/v1/me', { as: admin })).json().instance).toEqual({
      recoveryKitAcknowledged: true,
    });
    expect((await instanceAudit()).map((e) => e.action)).toEqual([
      'instance.recovery_kit_acknowledge',
    ]);
    expect(
      (await call(t, '/api/v1/admin/recovery-kit/acknowledge', { as: bob, body: {} })).statusCode,
    ).toBe(403);
  });
});
