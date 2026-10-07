import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { jar } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  auditOf,
  call,
  join,
  mailQueuedInvites,
  PASSWORD,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
} from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { MAX_PENDING_INVITES } from './routes.js';

// Task 20: invites through the front door (D33, D46, D48, D180, D193; §7.10).

const DAY = 86_400_000;

let db: TestDb;
let t: TestApp;
let sent: RecordedJob[];
let owner: Person;
let homeId: string;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  sent = [];
  t = await peopleApp(db, { sent });
  owner = await person(t, db, 'owner');
  const res = await call(t, '/api/v1/locations', {
    as: owner,
    body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
  });
  homeId = res.json().id;
});

const tokenOf = (url: string) => new URL(url).hash.slice(1);

async function invite(as: Person, body: Record<string, unknown> = { role: 'member' }) {
  return call(t, `/api/v1/locations/${homeId}/invites`, { as, body });
}

async function linkInvite(body: Record<string, unknown> = { role: 'member' }) {
  const res = await invite(owner, body);
  expect(res.statusCode, res.body).toBe(201);
  return { ...res.json(), token: tokenOf(res.json().url) };
}

async function membership(userId: string) {
  const { rows } = await ownerTx(db, (c) =>
    c.query(
      'SELECT role, expires_at, invited_by FROM public.memberships WHERE location_id = $1 AND user_id = $2',
      [homeId, userId],
    ),
  );
  return rows[0] ?? null;
}

describe('POST /api/v1/locations/:id/invites', () => {
  // catalogue: POST /api/v1/locations/:id/invites
  it('returns a single-use link and its QR code, stores only the hash, and audits it', async () => {
    const created = await linkInvite({ role: 'viewer' });
    expect(created.url).toMatch(new RegExp(`^${t.publicUrl}/invite#[A-Za-z0-9_-]{43}$`));
    expect(created.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>$/);
    expect(created).toMatchObject({ role: 'viewer', emailed: false, email: null });
    const ttl = new Date(created.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * DAY);
    expect(ttl).toBeLessThanOrEqual(7 * DAY);
    const { rows } = await ownerTx(db, (c) =>
      c.query('SELECT token_hash, created_by FROM public.invites WHERE id = $1', [created.id]),
    );
    expect(rows[0]).toEqual({
      token_hash: createHash('sha256').update(created.token).digest('hex'),
      created_by: owner.userId,
    });
    const events = await auditOf(db, homeId);
    expect(events.at(-1)).toMatchObject({ action: 'invite.create', actor_id: owner.userId });
    expect(JSON.stringify(events.at(-1)?.diff)).not.toContain(rows[0].token_hash);
  });

  it('keeps admin invites the owner’s (D48) and end dates within the inviter’s own (D180)', async () => {
    const admin = await person(t, db, 'admin');
    const member = await person(t, db, 'member');
    await join(db, homeId, admin.userId, 'admin', new Date(Date.now() + 3 * DAY));
    await join(db, homeId, member.userId, 'member');
    expect((await invite(admin, { role: 'admin' })).statusCode).toBe(403);
    expect((await invite(member, { role: 'viewer' })).statusCode).toBe(403);
    const tooLate = new Date(Date.now() + 5 * DAY).toISOString();
    expect((await invite(admin, { role: 'viewer', membershipExpiresAt: tooLate })).statusCode).toBe(
      400,
    );
    expect((await invite(admin, { role: 'viewer' })).statusCode).toBe(400);
    const inTime = new Date(Date.now() + 2 * DAY).toISOString();
    expect((await invite(admin, { role: 'viewer', membershipExpiresAt: inTime })).statusCode).toBe(
      201,
    );
  });

  it('refuses the Personal location', async () => {
    const res = await call(t, `/api/v1/locations/${owner.personalLocationId}/invites`, {
      as: owner,
      body: { role: 'member' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('mails an email invite by a job queued with it, and leaves its link out of the response', async () => {
    const res = await invite(owner, { role: 'member', email: 'Kid@Example.com' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      url: null,
      qrSvg: null,
      emailed: true,
      email: 'kid@example.com',
    });
    // Queued in the create transaction (review M9), not mailed from the request.
    expect(t.mail).toEqual([]);
    expect(sent).toEqual([{ name: 'send-invite-mail', data: { inviteId: res.json().id } }]);
    const hashAt = async () =>
      (
        await ownerTx(db, (c) =>
          c.query('SELECT token_hash FROM public.invites WHERE id = $1', [res.json().id]),
        )
      ).rows[0].token_hash as string;
    const created = await hashAt();
    await mailQueuedInvites(t, db, sent);
    // The job made the token it mailed; the one made at creation was never usable.
    const mailed = tokenOf((t.mail[0] as { url: string }).url);
    expect(await hashAt()).not.toBe(created);
    expect(await hashAt()).toBe(createHash('sha256').update(mailed).digest('hex'));
    expect(t.mail).toEqual([
      expect.objectContaining({
        kind: 'invite',
        to: 'kid@example.com',
        locationName: 'Home',
        role: 'member',
        url: expect.stringMatching(/\/invite#/),
      }),
    ]);
  });

  it('replays an idempotent retry without the link', async () => {
    const headers = { 'idempotency-key': 'invite-1' };
    const first = await call(t, `/api/v1/locations/${homeId}/invites`, {
      as: owner,
      body: { role: 'member' },
      headers,
    });
    const again = await call(t, `/api/v1/locations/${homeId}/invites`, {
      as: owner,
      body: { role: 'member' },
      headers,
    });
    expect(first.json().url).toEqual(expect.any(String));
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toMatchObject({ id: first.json().id, url: null, qrSvg: null });
  });

  it('allows 50 pending invites per location (review M9)', async () => {
    await ownerTx(db, async (c) => {
      for (let i = 0; i < MAX_PENDING_INVITES; i++) {
        await c.query(
          `INSERT INTO public.invites (location_id, role, token_hash, expires_at, created_by)
           VALUES ($1, 'member', $2, now() + interval '7 days', $3)`,
          [homeId, `hash-${i}-${Date.now()}`, owner.userId],
        );
      }
    });
    const res = await invite(owner);
    expect(res.statusCode).toBe(409);
  });

  // catalogue: DELETE /api/v1/locations/:id/invites/:inviteId
  it('lists pending invites for the owner, and revokes one', async () => {
    const created = await linkInvite();
    const members = (await call(t, `/api/v1/locations/${homeId}/members`, { as: owner })).json();
    expect(members.invites).toEqual([
      expect.objectContaining({
        id: created.id,
        role: 'member',
        createdByName: expect.any(String),
      }),
    ]);
    const revoke = await call(t, `/api/v1/locations/${homeId}/invites/${created.id}`, {
      method: 'DELETE',
      as: owner,
    });
    expect(revoke.statusCode).toBe(204);
    expect((await call(t, `/api/v1/invites/${created.token}`)).statusCode).toBe(404);
    expect((await auditOf(db, homeId)).at(-1)).toMatchObject({
      action: 'invite.revoke',
      actor_id: owner.userId,
    });
  });
});

describe('GET /api/v1/invites/:token', () => {
  it('previews a live invite for anyone holding the token', async () => {
    const until = new Date(Date.now() + 3 * DAY).toISOString();
    const created = await linkInvite({ role: 'viewer', membershipExpiresAt: until });
    const res = await call(t, `/api/v1/invites/${created.token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      location: { name: 'Home', kind: 'home' },
      inviterName: owner.email.split('@')[0],
      role: 'viewer',
      membershipExpiresAt: until,
      expiresAt: created.expiresAt,
      require2fa: false,
      emailBound: false,
      alreadyMemberLocationId: null,
    });
    // A member sees where to go instead.
    const mine = await call(t, `/api/v1/invites/${created.token}`, { as: owner });
    expect(mine.json().alreadyMemberLocationId).toBe(homeId);
  });

  it('answers 404 invite_invalid for a malformed, unknown or expired token', async () => {
    const created = await linkInvite();
    await ownerTx(db, (c) =>
      c.query(`UPDATE public.invites SET expires_at = now() - interval '1 second' WHERE id = $1`, [
        created.id,
      ]),
    );
    for (const token of ['short', 'A'.repeat(43), created.token]) {
      const res = await call(t, `/api/v1/invites/${token}`);
      expect(res.statusCode, token).toBe(404);
      expect(res.json().code).toBe('invite_invalid');
    }
  });
});

describe('POST /api/v1/invites/:token/accept, signed in', () => {
  // catalogue: POST /api/v1/invites/:token/accept
  it('joins with the invite’s role and end date, once, queues the owner’s notice, and audits', async () => {
    const until = new Date(Date.now() + 3 * DAY).toISOString();
    const created = await linkInvite({ role: 'viewer', membershipExpiresAt: until });
    const joiner = await person(t, db, 'joiner');
    const res = await call(t, `/api/v1/invites/${created.token}/accept`, { as: joiner, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ locationId: homeId, alreadyMember: false });
    expect(await membership(joiner.userId)).toEqual({
      role: 'viewer',
      expires_at: new Date(until),
      invited_by: owner.userId,
    });
    expect(sent).toEqual([
      { name: 'notify-owner-new-member', data: { locationId: homeId, userId: joiner.userId } },
    ]);
    expect((await auditOf(db, homeId)).at(-1)).toMatchObject({
      action: 'member.join',
      actor_id: joiner.userId,
    });
    // Single use.
    const second = await person(t, db, 'second');
    const again = await call(t, `/api/v1/invites/${created.token}/accept`, {
      as: second,
      body: {},
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('invite_invalid');
  });

  it('binds an email invite to its address, and marks that address verified', async () => {
    const joiner = await person(t, db, 'joiner');
    const other = await person(t, db, 'other');
    const res = await invite(owner, { role: 'member', email: joiner.email });
    await mailQueuedInvites(t, db, sent);
    const token = tokenOf((t.mail.at(-1) as { url: string }).url);
    expect(res.statusCode).toBe(201);
    const wrong = await call(t, `/api/v1/invites/${token}/accept`, { as: other, body: {} });
    expect(wrong.statusCode).toBe(404);
    const right = await call(t, `/api/v1/invites/${token}/accept`, { as: joiner, body: {} });
    expect(right.statusCode, right.body).toBe(200);
    const { rows } = await db.pools.auth.query(
      'SELECT email_verified FROM auth."user" WHERE id = $1',
      [joiner.userId],
    );
    expect(rows[0].email_verified).toBe(true);
  });

  it('joins a require_2fa location it then can’t see, and still records the join', async () => {
    await ownerTx(db, (c) =>
      c.query('UPDATE public.locations SET require_2fa = true WHERE id = $1', [homeId]),
    );
    // Created by the owner before the switch would hide it: insert directly.
    const created = await ownerTx(db, async (c) => {
      const token = 'B'.repeat(43);
      await c.query(
        `INSERT INTO public.invites (location_id, role, token_hash, expires_at, created_by)
         VALUES ($1, 'member', $2, now() + interval '7 days', $3)`,
        [homeId, createHash('sha256').update(token).digest('hex'), owner.userId],
      );
      return token;
    });
    const joiner = await person(t, db, 'joiner');
    const res = await call(t, `/api/v1/invites/${created}/accept`, { as: joiner, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect((await call(t, `/api/v1/locations/${homeId}`, { as: joiner })).statusCode).toBe(404);
    expect((await auditOf(db, homeId)).at(-1)).toMatchObject({
      action: 'member.join',
      actor_type: 'user',
      actor_id: joiner.userId,
    });
  });

  it('rejoins over the joiner’s own expired membership (review M7)', async () => {
    const joiner = await person(t, db, 'joiner');
    await join(db, homeId, joiner.userId, 'viewer', new Date(Date.now() - 1000));
    const created = await linkInvite({ role: 'member' });
    const res = await call(t, `/api/v1/invites/${created.token}/accept`, { as: joiner, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(await membership(joiner.userId)).toMatchObject({ role: 'member' });
  });

  it('needs a session or a new account', async () => {
    const created = await linkInvite();
    const res = await call(t, `/api/v1/invites/${created.token}/accept`, { body: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/v1/invites/:token/accept with newAccount (sign-up closed)', () => {
  const account = (email: string) => ({
    newAccount: { displayName: 'New Person', email, password: PASSWORD },
  });

  const signIn = async (email: string) => {
    const res = await call(t, '/api/v1/auth/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return { cookie: jar(res) };
  };

  it('creates the account and holds the invite for it; signing in and accepting joins', async () => {
    const created = await linkInvite({ role: 'member' });
    const email = `new-${Date.now()}@example.com`;
    const res = await call(t, `/api/v1/invites/${created.token}/accept`, { body: account(email) });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ next: 'sign-in' });
    expect(res.headers['set-cookie']).toBeUndefined();
    const { rows } = await db.pools.auth.query(
      `SELECT u.id, (SELECT count(*)::int FROM auth.session s WHERE s.user_id = u.id) AS sessions
         FROM auth."user" u WHERE u.email = $1`,
      [email],
    );
    expect(rows[0].sessions).toBe(0);
    // Held, not used: nobody has joined yet, and nobody else may sign up with it meanwhile.
    expect(await membership(rows[0].id)).toBeNull();
    const other = await call(t, `/api/v1/invites/${created.token}/accept`, {
      body: account(`other-${Date.now()}@example.com`),
    });
    expect(other.statusCode).toBe(404);
    // They sign in like anyone else, and accepting joins them.
    const me = await signIn(email);
    const accepted = await call(t, `/api/v1/invites/${created.token}/accept`, { as: me, body: {} });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await membership(rows[0].id)).toMatchObject({ role: 'member' });
  });

  it('makes one account at most from one link invite, however many sign up at once (review I1)', async () => {
    const created = await linkInvite();
    const stamp = Date.now();
    const emails = Array.from({ length: 6 }, (_, i) => `racer-${i}-${stamp}@example.com`);
    const answers = await Promise.all(
      emails.map((email) =>
        call(t, `/api/v1/invites/${created.token}/accept`, { body: account(email) }),
      ),
    );
    expect(answers.filter((r) => r.statusCode === 202)).toHaveLength(1);
    const { rows } = await db.pools.auth.query(
      'SELECT count(*)::int AS n FROM auth."user" WHERE email = ANY($1)',
      [emails],
    );
    expect(rows[0].n).toBe(1);
  });

  it('leaves the invite looking the same whether the address had an account (review I1)', async () => {
    const existing = await person(t, db, 'existing');
    const forTaken = await linkInvite();
    const forFree = await linkInvite();
    await call(t, `/api/v1/invites/${forTaken.token}/accept`, { body: account(existing.email) });
    await call(t, `/api/v1/invites/${forFree.token}/accept`, {
      body: account(`free-${Date.now()}@example.com`),
    });
    const taken = await call(t, `/api/v1/invites/${forTaken.token}`);
    const free = await call(t, `/api/v1/invites/${forFree.token}`);
    expect(taken.statusCode).toBe(200);
    expect(free.statusCode).toBe(200);
    const shape = (r: typeof taken) => {
      const { expiresAt: _e, ...rest } = r.json();
      return rest;
    };
    expect(shape(taken)).toEqual(shape(free));
    // And both are held against a second address alike.
    for (const token of [forTaken.token, forFree.token]) {
      const again = await call(t, `/api/v1/invites/${token}/accept`, {
        body: account(`second-${Date.now()}@example.com`),
      });
      expect(again.statusCode).toBe(404);
    }
  });

  it('answers the same for an address that already has an account, and joins nobody', async () => {
    const existing = await person(t, db, 'existing');
    const created = await linkInvite();
    const res = await call(t, `/api/v1/invites/${created.token}/accept`, {
      body: account(existing.email),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ next: 'sign-in' });
    expect(await membership(existing.userId)).toBeNull();
    expect(t.mail.at(-1)).toEqual({ kind: 'sign-up-existing', to: existing.email });
    // The invite is still there for them to accept once signed in.
    expect((await call(t, `/api/v1/invites/${created.token}`)).statusCode).toBe(200);
  });

  it('takes only its own address for an email invite', async () => {
    await invite(owner, { role: 'member', email: 'kid@example.com' });
    await mailQueuedInvites(t, db, sent);
    const token = tokenOf((t.mail.at(-1) as { url: string }).url);
    const wrong = await call(t, `/api/v1/invites/${token}/accept`, {
      body: account('someone@example.com'),
    });
    expect(wrong.statusCode).toBe(404);
    const right = await call(t, `/api/v1/invites/${token}/accept`, {
      body: account('Kid@example.com'),
    });
    expect(right.statusCode, right.body).toBe(202);
    const accepted = await call(t, `/api/v1/invites/${token}/accept`, {
      as: await signIn('kid@example.com'),
      body: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const { rows } = await db.pools.auth.query(
      'SELECT id, email_verified FROM auth."user" WHERE email = $1',
      ['kid@example.com'],
    );
    expect(rows[0].email_verified).toBe(true);
    expect(await membership(rows[0].id)).toMatchObject({ role: 'member' });
  });
});
