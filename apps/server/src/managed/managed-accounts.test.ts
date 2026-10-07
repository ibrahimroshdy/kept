import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { jar } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  auditOf,
  call,
  join,
  PASSWORD,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
} from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { RESET_CODE_LENGTH } from '../auth/managed.js';
import { MAX_MANAGED_PER_LOCATION } from './routes.js';

// Task 21: managed accounts (D47, D114, D164, D180) through the front door.

let db: TestDb;
let t: TestApp;
let sent: RecordedJob[];
let owner: Person;
let admin: Person;
let homeId: string;

const uname = () => `kid_${randomUUID().slice(0, 8)}`;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  sent = [];
  t = await peopleApp(db, { sent });
  owner = await person(t, db, 'owner');
  admin = await person(t, db, 'admin');
  const res = await call(t, '/api/v1/locations', {
    as: owner,
    body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
  });
  homeId = res.json().id;
  await join(db, homeId, admin.userId, 'admin');
});

async function createManaged(as: Person, body: Record<string, unknown> = {}) {
  return call(t, `/api/v1/locations/${homeId}/managed-accounts`, {
    as,
    body: { displayName: 'Kid', username: uname(), role: 'member', ...body },
  });
}

const redeem = (username: string, code: string, ip?: string) =>
  call(t, '/api/v1/auth/reset-code', {
    body: { username, code, newPassword: PASSWORD },
    ...(ip ? { ip } : {}),
  });

describe('POST /api/v1/locations/:id/managed-accounts', () => {
  // catalogue: POST /api/v1/locations/:id/managed-accounts
  it('creates the account, its membership and account, and hands back a one-time code', async () => {
    const username = `Kid_${randomUUID().slice(0, 6)}`;
    const res = await createManaged(admin, { username });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({
      username: username.toLowerCase(),
      displayName: 'Kid',
      role: 'member',
      expiresAt: null,
    });
    expect(created.code).toHaveLength(RESET_CODE_LENGTH);

    const { rows } = await ownerTx(db, (c) =>
      c.query(
        `SELECT p.managed, p.created_by_user_id, m.role, m.invited_by,
                (SELECT count(*)::int FROM public.locations l
                   JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
                  WHERE oa.user_id = p.user_id AND l.kind = 'personal') AS personal
           FROM public.user_profiles p
           JOIN public.memberships m ON m.user_id = p.user_id AND m.location_id = $2
          WHERE p.user_id = $1`,
        [created.userId, homeId],
      ),
    );
    // D114: even a managed account has its account and Personal location.
    expect(rows[0]).toEqual({
      managed: true,
      created_by_user_id: admin.userId,
      role: 'member',
      invited_by: admin.userId,
      personal: 1,
    });
    expect(sent).toEqual([
      { name: 'notify-owner-new-member', data: { locationId: homeId, userId: created.userId } },
    ]);
    expect((await auditOf(db, homeId)).at(-1)).toMatchObject({
      action: 'managed_account.create',
      actor_id: admin.userId,
    });

    // The person sets their password with the code, once, and signs in by username.
    expect((await redeem(created.username, created.code)).statusCode).toBe(204);
    expect((await redeem(created.username, created.code)).statusCode).toBe(400);
    const signIn = await call(t, '/api/v1/auth/sign-in/username', {
      body: { username: created.username, password: PASSWORD },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);

    // A managed account owns no location but its Personal one (D47, D114).
    const cookie = jar(signIn);
    const own = await call(t, '/api/v1/locations', {
      as: { cookie },
      body: { name: 'Mine', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    expect(own.statusCode).toBe(403);
  });

  it('follows the role rules (D48, D180) and refuses Personal locations', async () => {
    const member = await person(t, db, 'member');
    await join(db, homeId, member.userId, 'member');
    expect((await createManaged(member)).statusCode).toBe(403);
    expect((await createManaged(admin, { role: 'admin' })).statusCode).toBe(403);
    expect((await createManaged(owner, { role: 'admin' })).statusCode).toBe(201);
    const personal = await call(
      t,
      `/api/v1/locations/${owner.personalLocationId}/managed-accounts`,
      {
        as: owner,
        body: { displayName: 'Kid', username: uname(), role: 'member' },
      },
    );
    expect(personal.statusCode).toBe(409);
  });

  it('refuses a taken username and leaves no half-made account behind', async () => {
    const username = uname();
    expect((await createManaged(owner, { username })).statusCode).toBe(201);
    const again = await createManaged(owner, { username, displayName: 'Other' });
    expect(again.statusCode).toBe(409);
    const { rows } = await db.pools.auth.query(
      `SELECT count(*)::int AS n FROM auth."user" WHERE email LIKE '%@managed.invalid'`,
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('POST /api/v1/managed-accounts/:userId/reset-code', () => {
  // catalogue: POST /api/v1/managed-accounts/:userId/reset-code
  it('lets the creator and the owner issue a new code, signing the account out (D164)', async () => {
    const created = (await createManaged(admin)).json();
    await redeem(created.username, created.code);
    const signIn = await call(t, '/api/v1/auth/sign-in/username', {
      body: { username: created.username, password: PASSWORD },
    });
    const managedCookie = jar(signIn);
    expect((await call(t, '/api/v1/me', { as: { cookie: managedCookie } })).statusCode).toBe(200);

    const byOwner = await call(t, `/api/v1/managed-accounts/${created.userId}/reset-code`, {
      as: owner,
      body: {},
    });
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(byOwner.json().code).toHaveLength(RESET_CODE_LENGTH);
    expect((await call(t, '/api/v1/me', { as: { cookie: managedCookie } })).statusCode).toBe(401);

    const byCreator = await call(t, `/api/v1/managed-accounts/${created.userId}/reset-code`, {
      as: admin,
      body: {},
    });
    expect(byCreator.statusCode).toBe(200);
    // Only the newest code works.
    expect((await redeem(created.username, byOwner.json().code)).statusCode).toBe(400);
    expect((await redeem(created.username, byCreator.json().code)).statusCode).toBe(204);
    expect((await auditOf(db, homeId)).map((e) => e.action)).toContain(
      'managed_account.reset_code',
    );
  });

  it('refuses anyone else, and anyone who is not managed', async () => {
    const created = (await createManaged(owner)).json();
    const other = await person(t, db, 'other-admin');
    await join(db, homeId, other.userId, 'admin');
    const outsider = await person(t, db, 'outsider');
    const url = `/api/v1/managed-accounts/${created.userId}/reset-code`;
    expect((await call(t, url, { as: other, body: {} })).statusCode).toBe(403);
    expect((await call(t, url, { as: outsider, body: {} })).statusCode).toBe(404);
    const person_ = `/api/v1/managed-accounts/${admin.userId}/reset-code`;
    expect((await call(t, person_, { as: owner, body: {} })).statusCode).toBe(404);
  });
});

describe('reset authority (D197)', () => {
  const resetBy = (as: Person, userId: string) =>
    call(t, `/api/v1/managed-accounts/${userId}/reset-code`, { as, body: {} });

  it("ends with the creator's admin role in the home location; the owner keeps it", async () => {
    const created = (await createManaged(admin)).json();
    expect((await resetBy(admin, created.userId)).statusCode).toBe(200);
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.memberships SET role = 'member' WHERE user_id = $1 AND location_id = $2`,
        [admin.userId, homeId],
      ),
    );
    expect((await resetBy(admin, created.userId)).statusCode).toBe(403);
    expect((await resetBy(owner, created.userId)).statusCode).toBe(200);
  });

  it('gives the owner of another location the account joined no reset power', async () => {
    const created = (await createManaged(owner)).json();
    const other = await person(t, db, 'other-owner');
    const cabin = await call(t, '/api/v1/locations', {
      as: other,
      body: { name: 'Cabin', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    await join(db, cabin.json().id, created.userId, 'member');
    expect((await resetBy(other, created.userId)).statusCode).toBe(403);
  });

  // catalogue: POST /api/v1/auth/reset-code
  it('audits a redeemed code in the home location, as the person (review M3)', async () => {
    const created = (await createManaged(owner)).json();
    expect((await redeem(created.username, created.code)).statusCode).toBe(204);
    expect((await auditOf(db, homeId)).at(-1)).toMatchObject({
      action: 'managed_account.password_set',
      actor_type: 'user',
      actor_id: created.userId,
    });
  });

  it('holds 20 managed accounts per location (review M9)', async () => {
    await ownerTx(db, async (c) => {
      for (let i = 0; i < MAX_MANAGED_PER_LOCATION; i++) {
        const id = randomUUID();
        await c.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [
          id,
          'kid',
          `${id}@managed.invalid`,
        ]);
        await c.query(
          `INSERT INTO public.user_profiles (user_id, display_name, managed) VALUES ($1, 'Kid', true)`,
          [id],
        );
        await c.query(
          `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'member')`,
          [homeId, id],
        );
      }
    });
    expect((await createManaged(owner)).statusCode).toBe(409);
  });
});

describe('POST /api/v1/auth/reset-code', () => {
  it('limits one address trying many usernames (per IP)', async () => {
    const ip = '203.0.113.99';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await redeem(uname(), 'AAAAAAAA', ip)).statusCode);
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
