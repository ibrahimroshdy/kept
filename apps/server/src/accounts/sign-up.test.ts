import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { jar, type TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, PASSWORD, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { FRESH_SESSION_SECONDS } from '../auth/auth.js';
import { SIGN_UPS_PER_IP_PER_HOUR } from './sign-up.js';

// Signing up (security review of tasks 17–18; D33, D127, D190): Better Auth's public sign-up is
// off, and Kept's own answers the same whether the address is taken.

let db: TestDb;
let t: TestApp;

const newEmail = () => `new-${randomUUID()}@example.com`;
const body = (email: string, extra: Record<string, unknown> = {}) => ({
  email,
  password: PASSWORD,
  displayName: 'New Person',
  ...extra,
});

async function openSignUp(): Promise<void> {
  await ownerTx(db, (c) =>
    c.query(`INSERT INTO public.instance_settings (key, value) VALUES ('signup_open', 'true')`),
  );
}

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
});

describe("Better Auth's own sign-up and username probe", () => {
  it('are switched off over HTTP', async () => {
    const signUp = await call(t, '/api/v1/auth/sign-up/email', { body: body(newEmail()) });
    expect(signUp.statusCode).toBe(404);
    const probe = await call(t, '/api/v1/auth/is-username-available', {
      body: { username: 'anyone' },
    });
    expect(probe.statusCode).toBe(404);
  });

  it('asks for a sign-in in the last 10 minutes for sensitive changes (freshAge)', async () => {
    expect((await t.auth.$context).sessionConfig.freshAge).toBe(FRESH_SESSION_SECONDS);
    expect(FRESH_SESSION_SECONDS).toBe(600);
  });
});

describe('POST /api/v1/auth/sign-up', () => {
  it('is closed by default', async () => {
    const res = await call(t, '/api/v1/auth/sign-up', { body: body(newEmail()) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
  });

  // catalogue: POST /api/v1/auth/sign-up
  it('creates the account, with no session, when sign-up is open', async () => {
    await openSignUp();
    const email = newEmail();
    const res = await call(t, '/api/v1/auth/sign-up', { body: body(email) });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ next: 'sign-in' });
    expect(res.headers['set-cookie']).toBeUndefined();
    const { rows } = await db.pools.auth.query(
      `SELECT u.id, u.name, (SELECT count(*)::int FROM auth.session s WHERE s.user_id = u.id) AS n
         FROM auth."user" u WHERE u.email = $1`,
      [email],
    );
    expect(rows[0]).toMatchObject({ name: 'New Person', n: 0 });
    const signIn = await call(t, '/api/v1/auth/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    // ensureAccount ran: the Personal location is there.
    const { rows: locs } = await ownerTx(db, (c) =>
      c.query(
        `SELECT l.kind FROM public.locations l JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
          WHERE oa.user_id = $1`,
        [rows[0].id],
      ),
    );
    expect(locs).toEqual([{ kind: 'personal' }]);
    // …and audited its creation, as the new person.
    const { rows: audit } = await ownerTx(db, (c) =>
      c.query(
        `SELECT e.action, e.actor_id FROM public.audit_events e
           JOIN public.owner_accounts oa ON oa.id = e.owner_account_id
          WHERE oa.user_id = $1`,
        [rows[0].id],
      ),
    );
    expect(audit).toEqual([{ action: 'location.create', actor_id: rows[0].id }]);
  });

  it('answers a taken address exactly like a free one, and tells its owner', async () => {
    await openSignUp();
    const existing = await person(t, db, 'existing');
    const taken = await call(t, '/api/v1/auth/sign-up', { body: body(existing.email) });
    const free = await call(t, '/api/v1/auth/sign-up', { body: body(newEmail()) });
    expect(taken.statusCode).toBe(free.statusCode);
    expect(taken.body).toBe(free.body);
    expect(Object.keys(taken.headers).sort()).toEqual(Object.keys(free.headers).sort());
    expect(t.mail).toEqual([{ kind: 'sign-up-existing', to: existing.email }]);
    // Its owner hears of it once a day at most (review M9); the answer doesn't change.
    const again = await call(t, '/api/v1/auth/sign-up', { body: body(existing.email) });
    expect(again.statusCode).toBe(202);
    expect(t.mail).toHaveLength(1);
  });

  it('refuses a short password and an undeliverable address, open or not', async () => {
    await openSignUp();
    expect(
      (await call(t, '/api/v1/auth/sign-up', { body: body(newEmail(), { password: 'short' }) }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(t, '/api/v1/auth/sign-up', { body: body(`${randomUUID()}@managed.invalid`) }))
        .statusCode,
    ).toBe(400);
  });

  it('limits sign-ups per IP', async () => {
    await openSignUp();
    const ip = '203.0.113.77';
    for (let i = 0; i < SIGN_UPS_PER_IP_PER_HOUR; i++) {
      const res = await call(t, '/api/v1/auth/sign-up', {
        body: body(newEmail(), { password: 'short' }),
        ip,
      });
      expect(res.statusCode).toBe(400);
    }
    const limited = await call(t, '/api/v1/auth/sign-up', { body: body(newEmail()), ip });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toEqual(expect.any(String));
  });

  it('is open to the holder of a live invite, which it holds for that address', async () => {
    const owner = await person(t, db, 'owner');
    const home = await call(t, '/api/v1/locations', {
      as: owner,
      body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    const inv = await call(t, `/api/v1/locations/${home.json().id}/invites`, {
      as: owner,
      body: { role: 'viewer' },
    });
    const token = new URL(inv.json().url).hash.slice(1);
    const bad = await call(t, '/api/v1/auth/sign-up', {
      body: body(newEmail(), { inviteToken: 'C'.repeat(43) }),
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().code).toBe('invite_invalid');
    const email = newEmail();
    const res = await call(t, '/api/v1/auth/sign-up', {
      body: body(email, { inviteToken: token }),
    });
    expect(res.statusCode, res.body).toBe(202);
    // Held for that address (review I1): still previewable, closed to anyone else.
    expect((await call(t, `/api/v1/invites/${token}`)).statusCode).toBe(200);
    const other = await call(t, '/api/v1/auth/sign-up', {
      body: body(newEmail(), { inviteToken: token }),
    });
    expect(other.statusCode).toBe(404);
    // Signing in and accepting spends it.
    const signIn = await call(t, '/api/v1/auth/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const accepted = await call(t, `/api/v1/invites/${token}/accept`, {
      as: { cookie: jar(signIn) },
      body: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await call(t, `/api/v1/invites/${token}`)).statusCode).toBe(404);
  });
});
