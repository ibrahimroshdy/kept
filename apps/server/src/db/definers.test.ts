import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  asOwner,
  insertInvite,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
  userEmail,
} from '../../test/tenancy.js';
import { type Scope, withScope, withSystem } from './scope.js';

// The SECURITY DEFINER paths added by the RLS review (migration 0006): the deliberate ways
// past kept_app's policies. Each refuses everything it doesn't exist for.

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string, mfa = false): Scope => ({ userId, mfa });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

async function membership(locationId: string, userId: string) {
  const { rows } = await asOwner(db, (c) =>
    c.query(
      `SELECT role, expires_at, invited_by FROM public.memberships
        WHERE location_id = $1 AND user_id = $2`,
      [locationId, userId],
    ),
  );
  return rows[0] ?? null;
}

const accept = (user: string, hash: string, mfa = false) =>
  q<{ location_id: string }>(
    as(user, mfa),
    `SELECT kept.accept_invite($1, 'req-1') AS location_id`,
    [hash],
  );

const DAY = 86_400_000;

describe('kept.accept_invite()', () => {
  let a: Tenant;
  let joiner: string;

  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    joiner = await seedUser(db, 'joiner');
  });

  it("creates the membership with the invite's role and expiry, once", async () => {
    const until = new Date(Date.now() + 10 * DAY);
    const hash = await insertInvite(db, a.locationId, a.userId, {
      role: 'viewer',
      membershipExpiresAt: until,
    });
    expect(await accept(joiner, hash)).toEqual([{ location_id: a.locationId }]);
    expect(await membership(a.locationId, joiner)).toEqual({
      role: 'viewer',
      expires_at: until,
      invited_by: a.userId,
    });
    const invite = await asOwner(db, (c) =>
      c.query('SELECT accepted_by, accepted_at FROM public.invites WHERE token_hash = $1', [hash]),
    );
    expect(invite.rows[0].accepted_by).toBe(joiner);
    expect(invite.rows[0].accepted_at).not.toBeNull();
    // Single use: a second accept, by anyone, is refused.
    const other = await seedUser(db, 'other');
    for (const user of [joiner, other]) {
      expect(await pgError(accept(user, hash)), user).toMatchObject({
        code: '42501',
        constraint: 'invite_invalid',
      });
    }
  });

  it('refuses an unknown, expired or deleted-location invite, and a call without a scope', async () => {
    const expired = await insertInvite(db, a.locationId, a.userId, {
      expiresAt: new Date(Date.now() - 1000),
    });
    for (const hash of [expired, 'hash-nope']) {
      expect(await pgError(accept(joiner, hash)), hash).toMatchObject({
        code: '42501',
        constraint: 'invite_invalid',
      });
    }
    const live = await insertInvite(db, a.locationId, a.userId);
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.locations SET deleted_at = now(), purge_after = now() + interval '30 days'
          WHERE id = $1`,
        [a.locationId],
      ),
    );
    expect((await pgError(accept(joiner, live))).constraint).toBe('invite_invalid');
    const unscoped = await pgError(app.query('SELECT kept.accept_invite($1, NULL)', [live]));
    expect(unscoped.code).toBe('42501');
  });

  it("binds an email invite to the accepter's verified email", async () => {
    const email = await userEmail(db, joiner, false);
    const hash = await insertInvite(db, a.locationId, a.userId, { email: email.toUpperCase() });
    // Unverified: refused.
    expect((await pgError(accept(joiner, hash))).constraint).toBe('invite_invalid');
    // Someone else with a verified address: refused.
    const other = await seedUser(db, 'other');
    await userEmail(db, other, true);
    expect((await pgError(accept(other, hash))).constraint).toBe('invite_invalid');
    // The addressee, verified: accepted (case-insensitively).
    await userEmail(db, joiner, true);
    expect(await accept(joiner, hash)).toEqual([{ location_id: a.locationId }]);
  });

  it("follows its creator's standing: gone, no longer an admin, or an admin inviting an admin (D48, D180)", async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    // An admin may invite members, not admins (only the owner manages admins).
    const adminInvite = await insertInvite(db, a.locationId, admin, { role: 'admin' });
    expect((await pgError(accept(joiner, adminInvite))).constraint).toBe('invite_invalid');
    const ownerInvite = await insertInvite(db, a.locationId, a.userId, { role: 'admin' });
    const second = await seedUser(db, 'second');
    expect(await accept(second, ownerInvite)).toEqual([{ location_id: a.locationId }]);
    // The creator lost the role: their invites stop working.
    const memberInvite = await insertInvite(db, a.locationId, admin, { role: 'member' });
    await ownerTx(db, (c) =>
      c.query(`UPDATE public.memberships SET role = 'member' WHERE user_id = $1`, [admin]),
    );
    expect((await pgError(accept(joiner, memberInvite))).constraint).toBe('invite_invalid');
    // No creator at all (their account was deleted: created_by is SET NULL).
    const orphan = await insertInvite(db, a.locationId, null);
    expect((await pgError(accept(joiner, orphan))).constraint).toBe('invite_invalid');
  });

  it("caps the membership at the inviting admin's own expiry (D180)", async () => {
    const adminUntil = new Date(Date.now() + 5 * DAY);
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin', adminUntil);
    const open = await insertInvite(db, a.locationId, admin);
    expect(await accept(joiner, open)).toHaveLength(1);
    expect((await membership(a.locationId, joiner))?.expires_at).toEqual(adminUntil);
    const later = await insertInvite(db, a.locationId, admin, {
      membershipExpiresAt: new Date(Date.now() + 50 * DAY),
    });
    const other = await seedUser(db, 'other');
    await accept(other, later);
    expect((await membership(a.locationId, other))?.expires_at).toEqual(adminUntil);
  });

  it("can't make anyone but the accepter a member, nor an owner", async () => {
    const hash = await insertInvite(db, a.locationId, a.userId);
    await accept(joiner, hash);
    const { rows } = await asOwner(db, (c) =>
      c.query(`SELECT user_id, role FROM public.memberships WHERE location_id = $1 ORDER BY role`, [
        a.locationId,
      ]),
    );
    expect(rows).toEqual([
      { user_id: joiner, role: 'member' },
      { user_id: a.userId, role: 'owner' },
    ]);
  });
});

describe('kept.invite_preview()', () => {
  it("shows the location's name and kind, the role, the inviter and the dates, and nothing else", async () => {
    const a = await seedTenant(db, 'a');
    const until = new Date(Date.now() + 3 * DAY);
    const hash = await insertInvite(db, a.locationId, a.userId, {
      role: 'viewer',
      membershipExpiresAt: until,
    });
    // A public route: no user scope needed.
    const { rows, fields } = await app.query('SELECT * FROM kept.invite_preview($1)', [hash]);
    expect(fields.map((f) => f.name)).toEqual([
      'location_name',
      'location_kind',
      'role',
      'inviter_name',
      'expires_at',
      'membership_expires_at',
      'require_2fa',
      'email_bound',
      'email_matches',
      'member_location_id',
    ]);
    expect(rows).toEqual([
      {
        location_name: 'Home',
        location_kind: 'home',
        role: 'viewer',
        inviter_name: 'a',
        expires_at: expect.any(Date),
        membership_expires_at: until,
        require_2fa: false,
        email_bound: false,
        email_matches: false,
        member_location_id: null,
      },
    ]);
  });

  it("caps the membership's end at its creator's, and says whether the caller's email matches", async () => {
    const a = await seedTenant(db, 'a');
    const admin = await seedUser(db, 'admin');
    const adminUntil = new Date(Date.now() + 2 * DAY);
    await addMember(db, a.locationId, admin, 'admin', adminUntil);
    const joiner = await seedUser(db, 'joiner');
    const email = await userEmail(db, joiner, false);
    const hash = await insertInvite(db, a.locationId, admin, {
      email: email.toUpperCase(),
      membershipExpiresAt: new Date(Date.now() + 9 * DAY),
    });
    const [anon] = (await app.query('SELECT * FROM kept.invite_preview($1)', [hash])).rows;
    expect(anon).toMatchObject({
      membership_expires_at: adminUntil,
      email_bound: true,
      email_matches: false,
    });
    const [mine] = await q(as(joiner), 'SELECT * FROM kept.invite_preview($1)', [hash]);
    expect(mine).toMatchObject({
      email_bound: true,
      email_matches: true,
      member_location_id: null,
    });
    const [owner] = await q(as(a.userId), 'SELECT * FROM kept.invite_preview($1)', [hash]);
    // The owner already belongs: the page opens the location instead.
    expect(owner).toMatchObject({ email_matches: false, member_location_id: a.locationId });
  });

  it("shows nothing once the creator's own membership has ended", async () => {
    const a = await seedTenant(db, 'a');
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin', new Date(Date.now() + DAY));
    const hash = await insertInvite(db, a.locationId, admin);
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.memberships SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
        [admin],
      ),
    );
    expect((await app.query('SELECT * FROM kept.invite_preview($1)', [hash])).rows).toEqual([]);
  });

  it('shows nothing for an unknown, expired or accepted invite', async () => {
    const a = await seedTenant(db, 'a');
    const expired = await insertInvite(db, a.locationId, a.userId, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const used = await insertInvite(db, a.locationId, a.userId);
    await accept(await seedUser(db, 'j'), used);
    for (const hash of [expired, used, 'hash-nope']) {
      const { rows } = await app.query('SELECT * FROM kept.invite_preview($1)', [hash]);
      expect(rows, hash).toEqual([]);
    }
  });
});

describe('kept.claim_invite() (security review I1)', () => {
  const claim = async (hash: string, email: string) =>
    (await app.query<{ ok: boolean }>('SELECT kept.claim_invite($1, $2) AS ok', [hash, email]))
      .rows[0]?.ok;

  it('takes any address for a link invite, only its own for an email invite', async () => {
    const a = await seedTenant(db, 'a');
    const link = await insertInvite(db, a.locationId, a.userId);
    const bound = await insertInvite(db, a.locationId, a.userId, { email: 'Kid@Example.test' });
    expect(await claim(link, 'anyone@example.test')).toBe(true);
    expect(await claim(bound, 'kid@example.TEST')).toBe(true);
    expect(await claim(bound, 'other@example.test')).toBe(false);
  });

  it('holds the invite for one address for ten minutes; the same address may claim again', async () => {
    const a = await seedTenant(db, 'a');
    const link = await insertInvite(db, a.locationId, a.userId);
    expect(await claim(link, 'first@example.test')).toBe(true);
    expect(await claim(link, 'second@example.test')).toBe(false);
    expect(await claim(link, 'FIRST@example.test')).toBe(true);
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.invites SET claimed_at = now() - interval '11 minutes' WHERE token_hash = $1`,
        [link],
      ),
    );
    expect(await claim(link, 'second@example.test')).toBe(true);
  });

  it('lets exactly one of many concurrent claims through', async () => {
    const a = await seedTenant(db, 'a');
    const link = await insertInvite(db, a.locationId, a.userId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claim(link, `racer-${i}@example.test`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("doesn't change what the preview shows", async () => {
    const a = await seedTenant(db, 'a');
    const link = await insertInvite(db, a.locationId, a.userId);
    const preview = () => app.query('SELECT * FROM kept.invite_preview($1)', [link]);
    const before = (await preview()).rows;
    await claim(link, 'held@example.test');
    expect((await preview()).rows).toEqual(before);
  });

  it('refuses an unknown, expired, used, Personal or no-longer-backed invite', async () => {
    const a = await seedTenant(db, 'a');
    const expired = await insertInvite(db, a.locationId, a.userId, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const used = await insertInvite(db, a.locationId, a.userId);
    await accept(await seedUser(db, 'j'), used);
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    // An admin can't make admins (D48): the invite is dead on arrival.
    const adminMade = await insertInvite(db, a.locationId, admin, { role: 'admin' });
    const personal = await seedTenant(db, 'p', { kind: 'personal' });
    const toPersonal = await insertInvite(db, personal.locationId, personal.userId);
    for (const hash of [expired, used, adminMade, toPersonal, 'hash-nope']) {
      expect(await claim(hash, 'x@example.test'), hash).toBe(false);
    }
  });

  it('makes accept_invite() refuse everyone but the claimed address while the hold lasts', async () => {
    const a = await seedTenant(db, 'a');
    const link = await insertInvite(db, a.locationId, a.userId);
    const holder = await seedUser(db, 'holder');
    const holderEmail = await userEmail(db, holder, false);
    const other = await seedUser(db, 'other');
    expect(await claim(link, holderEmail)).toBe(true);
    expect((await pgError(accept(other, link))).constraint).toBe('invite_invalid');
    expect(await accept(holder, link)).toEqual([{ location_id: a.locationId }]);
  });
});

describe('kept.accept_invite() after migration 0010', () => {
  let a: Tenant;
  let joiner: string;

  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    joiner = await seedUser(db, 'joiner');
  });

  it('refuses an invite to a Personal location (D114)', async () => {
    const p = await seedTenant(db, 'p', { kind: 'personal' });
    const hash = await insertInvite(db, p.locationId, p.userId);
    expect((await pgError(accept(joiner, hash))).constraint).toBe('invite_invalid');
  });

  it("replaces the joiner's own expired membership instead of refusing (review M7)", async () => {
    await addMember(db, a.locationId, joiner, 'viewer', new Date(Date.now() - 1000));
    const hash = await insertInvite(db, a.locationId, a.userId, { role: 'member' });
    expect(await accept(joiner, hash)).toEqual([{ location_id: a.locationId }]);
    expect((await membership(a.locationId, joiner))?.role).toBe('member');
  });

  it('writes the join event itself, even into a location hidden from the session (review M3)', async () => {
    await ownerTx(db, (c) =>
      c.query('UPDATE public.locations SET require_2fa = true WHERE id = $1', [a.locationId]),
    );
    const hash = await insertInvite(db, a.locationId, a.userId);
    await accept(joiner, hash);
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT actor_type, actor_id, action, entity_type, owner_account_id, request_id,
                diff -> 'user_id' ->> 'after' AS user_id
           FROM public.audit_events WHERE location_id = $1 AND action = 'member.join'`,
        [a.locationId],
      ),
    );
    expect(rows).toEqual([
      {
        actor_type: 'user',
        actor_id: joiner,
        action: 'member.join',
        entity_type: 'membership',
        owner_account_id: a.accountId,
        request_id: 'req-1',
        user_id: joiner,
      },
    ]);
  });
});

describe('managed accounts: kept.create_managed_profile() and kept.add_managed_member() (D47)', () => {
  let a: Tenant;

  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  /** A Better Auth user as createManagedUser() makes one: a synthetic `.invalid` email. */
  const managedUser = () =>
    ownerTx(db, async (c) => {
      const id = newId();
      await c.query(`INSERT INTO auth."user" (id, name, email) VALUES ($1, 'kid', $2)`, [
        id,
        `${newId()}@managed.invalid`,
      ]);
      return id;
    });

  const createProfile = (by: string, userId: string) =>
    q(as(by), `SELECT kept.create_managed_profile($1, 'Kid')`, [userId]);
  const addManaged = (
    by: string,
    locationId: string,
    userId: string,
    role = 'member',
    until: Date | null = null,
  ) =>
    q<{ id: string }>(as(by), 'SELECT kept.add_managed_member($1, $2, $3, $4) AS id', [
      locationId,
      userId,
      role,
      until,
    ]);

  it('creates a managed profile marked with its creator, for a managed auth user only', async () => {
    const kid = await managedUser();
    await createProfile(a.userId, kid);
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT managed, created_by_user_id FROM public.user_profiles WHERE user_id = $1', [
        kid,
      ]),
    );
    expect(rows).toEqual([{ managed: true, created_by_user_id: a.userId }]);
    // Twice: the profile exists.
    expect((await pgError(createProfile(a.userId, kid))).code).toBe('23505');
    // A real user (a real email, even one with no profile yet) can't be claimed.
    const real = await ownerTx(db, async (c) => {
      const id = newId();
      await c.query(`INSERT INTO auth."user" (id, name, email) VALUES ($1, 'r', $2)`, [
        id,
        `${id}@example.test`,
      ]);
      return id;
    });
    expect((await pgError(createProfile(a.userId, real))).code).toBe('42501');
    // Someone who administers nothing can't create managed accounts.
    const loner = await seedUser(db, 'loner');
    expect((await pgError(createProfile(loner, await managedUser()))).code).toBe('42501');
  });

  it('adds a managed account its creator made, with the role asked for', async () => {
    const kid = await managedUser();
    await createProfile(a.userId, kid);
    const [row] = await addManaged(a.userId, a.locationId, kid, 'viewer');
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await membership(a.locationId, kid)).toEqual({
      role: 'viewer',
      expires_at: null,
      invited_by: a.userId,
    });
  });

  it("refuses an ordinary user, another admin's managed account elsewhere, or an owner role", async () => {
    const b = await seedTenant(db, 'b');
    // B's own user is not managed.
    expect((await pgError(addManaged(a.userId, a.locationId, b.userId))).code).toBe('42501');
    // B's managed kid, in none of A's locations: not A's to add.
    const kid = await managedUser();
    await createProfile(b.userId, kid);
    expect((await pgError(addManaged(a.userId, a.locationId, kid))).code).toBe('42501');
    // Nobody is made an owner this way.
    const mine = await managedUser();
    await createProfile(a.userId, mine);
    expect((await pgError(addManaged(a.userId, a.locationId, mine, 'owner'))).code).toBe('42501');
    // Nor added to a location the caller doesn't administer.
    expect((await pgError(addManaged(a.userId, b.locationId, mine))).code).toBe('42501');
  });

  it("lets an owner add a managed account that is already in one of the owner's locations", async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    const kid = await managedUser();
    await createProfile(admin, kid);
    await addManaged(admin, a.locationId, kid);
    // A second location of A's: A (not the kid's creator) may add the kid, being a fellow member.
    const second = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Cabin' }));
    await addManaged(a.userId, second.locationId, kid);
    expect((await membership(second.locationId, kid))?.role).toBe('member');
  });

  it('holds admins to D48 and D180: no admin role, no longer than their own membership', async () => {
    const until = new Date(Date.now() + 3 * DAY);
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin', until);
    const kid = await managedUser();
    await createProfile(admin, kid);
    expect((await pgError(addManaged(admin, a.locationId, kid, 'admin'))).code).toBe('42501');
    await addManaged(admin, a.locationId, kid, 'member', new Date(Date.now() + 30 * DAY));
    expect((await membership(a.locationId, kid))?.expires_at).toEqual(until);
    // A member (not admin) can't add anyone.
    const member = await seedUser(db, 'member');
    await addMember(db, a.locationId, member, 'member');
    const other = await managedUser();
    await createProfile(admin, other);
    expect((await pgError(addManaged(member, a.locationId, other))).code).toBe('42501');
  });

  const resetLocation = async (by: string, kid: string) =>
    (
      await q<{ loc: string | null }>(as(by), 'SELECT kept.managed_reset_location($1) AS loc', [
        kid,
      ])
    )[0]?.loc ?? null;

  it('records the first location as home, and refuses a Personal one (D114, D197)', async () => {
    const kid = await managedUser();
    await createProfile(a.userId, kid);
    const personal = await ownerTx(db, (c) => insertLocation(c, a, { kind: 'personal' }));
    expect((await pgError(addManaged(a.userId, personal.locationId, kid))).code).toBe('42501');
    await addManaged(a.userId, a.locationId, kid);
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT created_in_location_id FROM public.user_profiles WHERE user_id = $1', [kid]),
    );
    expect(rows[0]?.created_in_location_id).toBe(a.locationId);
  });

  it('gives reset authority to the home owner, and the creator only while still an admin there (D197)', async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    const kid = await managedUser();
    await createProfile(admin, kid);
    await addManaged(admin, a.locationId, kid);
    expect(await resetLocation(admin, kid)).toBe(a.locationId);
    expect(await resetLocation(a.userId, kid)).toBe(a.locationId);

    // Demoted: the creator keeps nothing.
    await ownerTx(db, (c) =>
      c.query(`UPDATE public.memberships SET role = 'member' WHERE user_id = $1`, [admin]),
    );
    expect(await resetLocation(admin, kid)).toBeNull();
    // Nor once their membership has ended, even as an admin.
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.memberships SET role = 'admin', expires_at = now() - interval '1 second'
          WHERE user_id = $1`,
        [admin],
      ),
    );
    expect(await resetLocation(admin, kid)).toBeNull();
    // So they can't add it anywhere else either.
    const elsewhere = await seedTenant(db, 'elsewhere');
    await addMember(db, elsewhere.locationId, admin, 'admin');
    expect((await pgError(addManaged(admin, elsewhere.locationId, kid))).code).toBe('42501');
  });

  it('gives owners of the other locations it joined no reset power (D197)', async () => {
    const kid = await managedUser();
    await createProfile(a.userId, kid);
    await addManaged(a.userId, a.locationId, kid);
    // A is an admin of B's location, and adds the kid there with A's own authority.
    const b = await seedTenant(db, 'b');
    await addMember(db, b.locationId, a.userId, 'admin');
    await addManaged(a.userId, b.locationId, kid);
    // B owns a location the kid is in, and still may not reset it or add it elsewhere.
    expect(await resetLocation(b.userId, kid)).toBeNull();
    const bSecond = await ownerTx(db, (c) => insertLocation(c, b, { name: 'Cabin' }));
    expect((await pgError(addManaged(b.userId, bSecond.locationId, kid))).code).toBe('42501');
  });
});

describe('kept.ensure_audit_partitions() (task 24)', () => {
  const sys = (monthsAhead: number) =>
    withSystem(db.pools.system, async (_tx, c) => {
      const { rows } = await c.query('SELECT kept.ensure_audit_partitions($1) AS n', [monthsAhead]);
      return rows[0].n as number;
    });

  const partitions = () =>
    asOwner(db, async (c) => {
      const { rows } = await c.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'public.audit_events'::regclass ORDER BY 1`,
      );
      return rows.map((r) => r.name);
    });

  const monthName = (offset: number) => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return `audit_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  it('keeps three months ahead from the migration, and adds more for kept_system, idempotently', async () => {
    const before = await partitions();
    for (const offset of [0, 1, 2, 3]) expect(before).toContain(monthName(offset));
    expect(await sys(5)).toBe(2);
    expect(await sys(5)).toBe(0);
    const after = await partitions();
    expect(after).toContain(monthName(5));
    // Each new partition is locked like the rest: no direct access for the runtime roles.
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT has_table_privilege('kept_app', $1, 'SELECT') AS app,
                has_table_privilege('kept_system', $1, 'SELECT') AS sys`,
        [`public.${monthName(5)}`],
      ),
    );
    expect(rows[0]).toEqual({ app: false, sys: false });
  });

  it('is for kept_system only, and bounded', async () => {
    const t = await seedTenant(db, 'a');
    const err = await pgError(q(as(t.userId), 'SELECT kept.ensure_audit_partitions(3)'));
    expect(err.code).toBe('42501');
    expect((await pgError(sys(100))).code).toBe('22023');
  });

  it('refuses a month whose rows already landed in the default partition, by name', async () => {
    // Nine months out: past every partition the tests above could have made.
    const future = new Date();
    future.setUTCMonth(future.getUTCMonth() + 9, 15);
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.audit_events (at, actor_type, action, entity_type)
         VALUES ($1, 'system', 'x', 'y')`,
        [future],
      ),
    );
    try {
      expect(await pgError(sys(10))).toMatchObject({
        code: '23514',
        constraint: 'audit_events_default_has_rows',
      });
    } finally {
      await ownerTx(db, (c) => c.query('DELETE FROM public.audit_events_default'));
    }
  });
});

describe('first run and instance admin doors (migration 0009, tasks 22–23)', () => {
  const sys = <T>(text: string, values: unknown[] = []) =>
    withSystem(db.pools.system, async (_tx, c) => (await c.query(text, values)).rows as T[]);
  const hasAdmin = async () =>
    (await sys<{ yes: boolean }>('SELECT kept.instance_has_admin() AS yes'))[0]?.yes;

  it('kept.instance_has_admin(): kept_system learns only whether one exists', async () => {
    expect(await hasAdmin()).toBe(false);
    const a = await seedUser(db, 'first');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [a]),
    );
    expect(await hasAdmin()).toBe(true);
    // Still no read of the table itself.
    expect(await sys('SELECT * FROM public.instance_admins')).toEqual([]);
    const t = await seedTenant(db, 'app');
    expect((await pgError(q(as(t.userId), 'SELECT kept.instance_has_admin()'))).code).toBe('42501');
  });

  it('kept.claim_first_instance_admin(): the first admin once, then refused by name', async () => {
    const a = await seedUser(db, 'first');
    const b = await seedUser(db, 'second');
    await sys('SELECT kept.claim_first_instance_admin($1)', [a]);
    expect(await pgError(sys('SELECT kept.claim_first_instance_admin($1)', [b]))).toMatchObject({
      code: '23514',
      constraint: 'instance_already_set_up',
    });
    const admins = await asOwner(db, (c) => c.query('SELECT user_id FROM public.instance_admins'));
    expect(admins.rows).toEqual([{ user_id: a }]);
  });

  it('kept.claim_first_instance_admin(): refuses an unknown user, and kept_app', async () => {
    expect((await pgError(sys('SELECT kept.claim_first_instance_admin($1)', [newId()]))).code).toBe(
      '42501',
    );
    const t = await seedTenant(db, 'app');
    expect(
      (await pgError(q(as(t.userId), 'SELECT kept.claim_first_instance_admin($1)', [t.userId])))
        .code,
    ).toBe('42501');
    expect(await hasAdmin()).toBe(false);
  });

  it('kept.admin_user_summaries(): role counts for an instance admin, nothing for anyone else', async () => {
    const admin = await seedTenant(db, 'admin');
    const other = await seedTenant(db, 'other');
    await addMember(db, other.locationId, admin.userId, 'viewer');
    await addMember(db, admin.locationId, other.userId, 'admin');
    await addMember(
      db,
      admin.locationId,
      (await seedUser(db, 'gone')) as string,
      'member',
      new Date(Date.now() - 1000),
    );
    const ids = [admin.userId, other.userId];
    expect(
      (await pgError(q(as(admin.userId), 'SELECT * FROM kept.admin_user_summaries($1)', [ids])))
        .code,
    ).toBe('42501');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]),
    );
    const rows = await q<{ user_id: string }>(
      as(admin.userId),
      'SELECT * FROM kept.admin_user_summaries($1) ORDER BY display_name',
      [ids],
    );
    expect(rows).toEqual([
      {
        user_id: admin.userId,
        display_name: 'admin',
        managed: false,
        instance_admin: true,
        owner_of: 1,
        admin_of: 0,
        member_of: 0,
        viewer_of: 1,
      },
      {
        user_id: other.userId,
        display_name: 'other',
        managed: false,
        instance_admin: false,
        owner_of: 1,
        admin_of: 1,
        member_of: 0,
        viewer_of: 0,
      },
    ]);
    expect((await pgError(sys('SELECT * FROM kept.admin_user_summaries($1)', [ids]))).code).toBe(
      '42501',
    );
  });
});
