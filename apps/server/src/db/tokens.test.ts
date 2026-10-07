import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { expireMemberships } from '../locations/membership-jobs.js';
import { type Scope, withScope, withSystem } from './scope.js';

// Step-6 T4 (0069, 0070): tokens as RLS principals, OAuth grants, the rate windows, and tokens
// dying with their creator's access (engineering spec §1.10, §3.2, §7.13; D63, D180, D190; plan
// Q6, Q7, Q19). Bruce is an admin of Ibrahim's Home and a member of his Garage.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home
let garage: { locationId: string; unplacedId: string };
let vault: { locationId: string; unplacedId: string }; // require_2fa
let bruce: string;
let louis: string; // member of Home
let talia: string; // viewer of Home
let homeThing: string;
let garageThing: string;

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const as = <T>(scope: Scope, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, scope, (_tx, c) => fn(c));
const user = (userId: string, mfa = true): Scope => ({ userId, mfa });
const random = () => crypto.randomUUID().replace(/-/g, '');
const hash = () => `${random()}${random()}`;
const lookup = () => random().slice(0, 8);

/** A personal token made by `userId` in their own scope, limited to `locations`. */
async function token(
  userId: string,
  scope: 'read' | 'write',
  locations: string[],
  opts: { mfa?: boolean; hash?: string; lookup?: string; expiresAt?: Date } = {},
): Promise<string> {
  return as(user(userId, opts.mfa ?? false), async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.api_tokens (id, user_id, kind, name, lookup, hash, scope,
                                      created_with_mfa, expires_at)
       VALUES ($1, $2, 'personal', 'Shortcuts', $3, $4, $5, $6, $7)`,
      [
        id,
        userId,
        opts.lookup ?? lookup(),
        opts.hash ?? hash(),
        scope,
        opts.mfa ?? false,
        opts.expiresAt ?? null,
      ],
    );
    for (const loc of locations) {
      await c.query('INSERT INTO public.token_locations (token_id, location_id) VALUES ($1, $2)', [
        id,
        loc,
      ]);
    }
    return id;
  });
}

const viaToken = (userId: string, tokenId: string, mfa = false): Scope => ({
  userId,
  mfa,
  tokenId,
});
const thingsIn = (scope: Scope, locationId: string) =>
  as(
    scope,
    async (c) =>
      (
        await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM public.things WHERE location_id = $1',
          [locationId],
        )
      ).rows[0]?.n,
  );
const addThing = (scope: Scope, t: { locationId: string; unplacedId: string }) =>
  as(scope, (c) =>
    c.query(`INSERT INTO public.things (location_id, place_id, name) VALUES ($1, $2, 'Drill')`, [
      t.locationId,
      t.unplacedId,
    ]),
  );
const tokenRow = async (id: string) =>
  (
    await own<{ revoked_at: Date | null; revoked_reason: string | null; locations: string[] }>(
      `SELECT t.revoked_at, t.revoked_reason,
              ARRAY(SELECT tl.location_id::text FROM public.token_locations tl
                     WHERE tl.token_id = t.id ORDER BY 1) AS locations
         FROM public.api_tokens t WHERE t.id = $1`,
      [id],
    )
  )[0];

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'tok-ibrahim', { name: 'Home' });
  const locs = await ownerTx(db, async (c) => ({
    garage: await insertLocation(c, ibrahim, { name: 'Garage' }),
    vault: await insertLocation(c, ibrahim, { name: 'Vault', require2fa: true }),
  }));
  garage = locs.garage;
  vault = locs.vault;
  bruce = await seedUser(db, 'tok-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  await addMember(db, garage.locationId, bruce, 'member');
  await addMember(db, vault.locationId, bruce, 'member');
  louis = await seedUser(db, 'tok-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  talia = await seedUser(db, 'tok-talia');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  homeThing = newId();
  garageThing = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name)
     VALUES ($1, $2, $3, 'HDMI cable'), ($4, $5, $6, 'Jack')`,
    [
      homeThing,
      ibrahim.locationId,
      ibrahim.unplacedId,
      garageThing,
      garage.locationId,
      garage.unplacedId,
    ],
  );
});

describe('the token principal (Q6, D180)', () => {
  it('reads only its locations, and writes nothing with a read token, though Bruce can', async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId]);
    expect(await thingsIn(viaToken(bruce, read), ibrahim.locationId)).toBe(1);
    expect(await thingsIn(viaToken(bruce, read), garage.locationId)).toBe(0);
    expect(await thingsIn(user(bruce), garage.locationId)).toBe(1);
    expect((await pgError(addThing(viaToken(bruce, read), ibrahim))).code).toBe('42501');
    const ids = await as(viaToken(bruce, read), async (c) => ({
      writable: (await c.query('SELECT kept.writable_location_ids()')).rowCount,
      admin: (await c.query('SELECT kept.admin_location_ids()')).rowCount,
    }));
    expect(ids).toEqual({ writable: 0, admin: 0 });
  });

  it('writes in its own locations only with a write token', async () => {
    const write = await token(bruce, 'write', [ibrahim.locationId]);
    await addThing(viaToken(bruce, write), ibrahim);
    expect((await pgError(addThing(viaToken(bruce, write), garage))).code).toBe('42501');
  });

  it("is nobody's but its creator's, and a token of someone else sees nothing", async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId]);
    expect(await thingsIn(viaToken(louis, read), ibrahim.locationId)).toBe(0);
  });

  it('sees nothing on the next statement once revoked or expired', async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId]);
    await as(user(bruce), (c) =>
      c.query(
        `UPDATE public.api_tokens SET revoked_at = now(), revoked_reason = 'user' WHERE id = $1`,
        [read],
      ),
    );
    expect(await thingsIn(viaToken(bruce, read), ibrahim.locationId)).toBe(0);
    const expired = await token(bruce, 'read', [ibrahim.locationId], {
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await thingsIn(viaToken(bruce, expired), ibrahim.locationId)).toBe(1);
    await own(
      `UPDATE public.api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired],
    );
    expect(await thingsIn(viaToken(bruce, expired), ibrahim.locationId)).toBe(0);
  });

  it("follows Bruce's membership on every call, with no job: an expired one reads nothing", async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId]);
    await own(
      `UPDATE public.memberships SET expires_at = now() - interval '1 second'
        WHERE user_id = $1 AND location_id = $2`,
      [bruce, ibrahim.locationId],
    );
    expect(await thingsIn(viaToken(bruce, read), ibrahim.locationId)).toBe(0);
  });

  it("needs the token's own second factor in a require_2fa location", async () => {
    const plain = await pgError(token(bruce, 'read', [vault.locationId]));
    expect(plain).toMatchObject({ code: '42501', constraint: 'token_locations_mfa' });
    const strong = await token(bruce, 'read', [vault.locationId], { mfa: true });
    await addThing(user(bruce), vault);
    expect(await thingsIn(viaToken(bruce, strong, true), vault.locationId)).toBe(1);
    await own(`UPDATE public.api_tokens SET created_with_mfa = false WHERE id = $1`, [strong]);
    expect(await thingsIn(viaToken(bruce, strong, true), vault.locationId)).toBe(0);
  });

  it('is never an instance admin (D180)', async () => {
    await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [bruce]);
    const write = await token(bruce, 'write', [ibrahim.locationId]);
    const [plain, viaTok] = await Promise.all([
      as(user(bruce), async (c) => (await c.query('SELECT kept.is_instance_admin() AS v')).rows[0]),
      as(
        viaToken(bruce, write),
        async (c) => (await c.query('SELECT kept.is_instance_admin() AS v')).rows[0],
      ),
    ]);
    expect([plain?.v, viaTok?.v]).toEqual([true, false]);
  });

  it('plans the thing list the same way with a token as without (§7.2)', async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId]);
    const plan = (scope: Scope) =>
      as(scope, async (c) =>
        (
          await c.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN (COSTS OFF) SELECT id, name FROM public.things
              WHERE location_id = $1 AND deleted_at IS NULL ORDER BY name LIMIT 50`,
            [ibrahim.locationId],
          )
        ).rows
          .map((r) => r['QUERY PLAN'])
          .join('\n'),
      );
    expect(await plan(viaToken(bruce, read))).toBe(await plan(user(bruce)));
  });
});

describe('api_tokens and token_locations under RLS', () => {
  it("hides the secret's HMAC from kept_app, and every row from a token principal", async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId]);
    expect(
      (
        await pgError(
          as(user(bruce), (c) =>
            c.query('SELECT hash FROM public.api_tokens WHERE id = $1', [read]),
          ),
        )
      ).code,
    ).toBe('42501');
    const seen = await as(viaToken(bruce, read), async (c) => ({
      tokens: (await c.query('SELECT id FROM public.api_tokens')).rowCount,
      locations: (await c.query('SELECT token_id FROM public.token_locations')).rowCount,
    }));
    expect(seen).toEqual({ tokens: 0, locations: 0 });
  });

  it('keeps a token from another member of the same location, even its admin (D63)', async () => {
    await token(louis, 'read', [ibrahim.locationId]);
    const n = await as(
      user(bruce),
      async (c) =>
        (await c.query('SELECT id FROM public.api_tokens WHERE user_id = $1', [louis])).rowCount,
    );
    expect(n).toBe(0);
  });

  it('refuses an OAuth row, or a second factor the session never passed', async () => {
    const oauth = await pgError(
      as(user(bruce), (c) =>
        c.query(
          `INSERT INTO public.api_tokens (user_id, kind, name, oauth_client_id, scope)
           VALUES ($1, 'oauth', 'Claude', 'https://claude.example/client.json', 'read')`,
          [bruce],
        ),
      ),
    );
    expect(oauth.code).toBe('42501');
    const claimed = await pgError(
      as(user(bruce, false), (c) =>
        c.query(
          `INSERT INTO public.api_tokens (user_id, kind, name, lookup, hash, scope, created_with_mfa)
           VALUES ($1, 'personal', 'x', $2, $3, 'read', true)`,
          [bruce, lookup(), hash()],
        ),
      ),
    );
    expect(claimed.code).toBe('42501');
  });

  it("refuses a write token where its creator is a viewer, and a location they aren't in", async () => {
    expect(await pgError(token(talia, 'write', [ibrahim.locationId]))).toMatchObject({
      code: '42501',
      constraint: 'token_locations_role',
    });
    await token(talia, 'read', [ibrahim.locationId]);
    expect((await pgError(token(louis, 'read', [garage.locationId]))).code).toBe('42501');
  });

  it('revokes a token left with no location, and a revoked token stays revoked', async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId, garage.locationId]);
    await as(user(bruce), (c) =>
      c.query('DELETE FROM public.token_locations WHERE token_id = $1', [read]),
    );
    expect(await tokenRow(read)).toMatchObject({ revoked_reason: 'user', locations: [] });
    expect(
      await pgError(
        as(user(bruce), (c) =>
          c.query(
            'UPDATE public.api_tokens SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1',
            [read],
          ),
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'api_tokens_revoked_final' });
  });
});

describe('tokens die with access (D180)', () => {
  it('revokes the only-Home tokens and drops Home from the others when Bruce leaves Home', async () => {
    const only = await token(bruce, 'read', [ibrahim.locationId]);
    const both = await token(bruce, 'write', [ibrahim.locationId, garage.locationId]);
    await as(user(bruce), (c) =>
      c.query('DELETE FROM public.memberships WHERE user_id = $1 AND location_id = $2', [
        bruce,
        ibrahim.locationId,
      ]),
    );
    expect(await tokenRow(only)).toMatchObject({
      revoked_reason: 'membership_ended',
      locations: [ibrahim.locationId],
    });
    expect(await tokenRow(both)).toMatchObject({
      revoked_at: null,
      locations: [garage.locationId],
    });
  });

  it('revokes when an admin removes someone, and when expire-memberships ends it', async () => {
    const louisToken = await token(louis, 'read', [ibrahim.locationId]);
    await as(user(ibrahim.userId), (c) =>
      c.query('DELETE FROM public.memberships WHERE user_id = $1 AND location_id = $2', [
        louis,
        ibrahim.locationId,
      ]),
    );
    expect(await tokenRow(louisToken)).toMatchObject({ revoked_reason: 'membership_ended' });

    const taliaToken = await token(talia, 'read', [ibrahim.locationId]);
    await own(
      `UPDATE public.memberships SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND location_id = $2`,
      [talia, ibrahim.locationId],
    );
    const expired = await expireMemberships(db.pools);
    expect(expired.map((e) => e.userId)).toContain(talia);
    expect(await tokenRow(taliaToken)).toMatchObject({ revoked_reason: 'membership_ended' });
  });

  it("takes Home from Louis's write tokens, not his read ones, when he becomes a viewer (Q6)", async () => {
    const write = await token(louis, 'write', [ibrahim.locationId]);
    const read = await token(louis, 'read', [ibrahim.locationId]);
    await as(user(ibrahim.userId), (c) =>
      c.query(
        `UPDATE public.memberships SET role = 'viewer' WHERE user_id = $1 AND location_id = $2`,
        [louis, ibrahim.locationId],
      ),
    );
    expect(await tokenRow(write)).toMatchObject({ revoked_reason: 'role_lost' });
    expect(await tokenRow(read)).toMatchObject({
      revoked_at: null,
      locations: [ibrahim.locationId],
    });
  });

  it('lets a deleted user and a purged location take their tokens with them', async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId, garage.locationId]);
    await own('DELETE FROM public.locations WHERE id = $1', [garage.locationId]);
    expect(await tokenRow(read)).toMatchObject({
      revoked_at: null,
      locations: [ibrahim.locationId],
    });
    await own('DELETE FROM auth."user" WHERE id = $1', [bruce]);
    expect(await tokenRow(read)).toBeUndefined();
  });

  it('kept.revoke_tokens_for(): the user, an admin of the location, or the system; never a token', async () => {
    const read = await token(louis, 'read', [ibrahim.locationId]);
    const call = (scope: Scope | 'system') => {
      const sql = `SELECT kept.revoke_tokens_for($1, $2, 'admin') AS n`;
      const args = [louis, ibrahim.locationId];
      return scope === 'system'
        ? withSystem(db.pools.system, async (_tx, c) => (await c.query(sql, args)).rows[0]?.n)
        : as(scope, async (c) => (await c.query(sql, args)).rows[0]?.n);
    };
    expect((await pgError(call(user(talia)))).code).toBe('42501');
    expect((await pgError(call(viaToken(louis, read)))).code).toBe('42501');
    expect(await call(user(bruce))).toBe(1);
    expect(await call('system')).toBe(0);
  });
});

describe('the audit actor (step-1 carry-over)', () => {
  const event = (scope: Scope, actorType: 'user' | 'token', actorId: string) =>
    as(scope, (c) =>
      c.query(
        `INSERT INTO public.audit_events
           (location_id, owner_account_id, actor_type, actor_id, action, entity_type, entity_id)
         VALUES ($1, $2, $3, $4, 'thing.update', 'thing', $5)`,
        [ibrahim.locationId, ibrahim.accountId, actorType, actorId, homeThing],
      ),
    );

  it('writes token events pinned to the token in a token scope, and user events only without one', async () => {
    const write = await token(bruce, 'write', [ibrahim.locationId]);
    await event(viaToken(bruce, write), 'token', write);
    expect((await pgError(event(viaToken(bruce, write), 'user', bruce))).code).toBe('42501');
    expect((await pgError(event(user(bruce), 'token', write))).code).toBe('42501');
    const other = await token(bruce, 'write', [ibrahim.locationId]);
    expect((await pgError(event(viaToken(bruce, write), 'token', other))).code).toBe('42501');
    await event(user(bruce), 'user', bruce);
  });
});

describe('the doors', () => {
  it('kept.token_verify(): the right HMAC, live, with no scope; stamps last use', async () => {
    const h = hash();
    const l = lookup();
    const id = await token(bruce, 'write', [ibrahim.locationId], { hash: h, lookup: l, mfa: true });
    const verify = async (lk: string, hh: string) =>
      (await db.pools.app.query('SELECT * FROM kept.token_verify($1, $2)', [lk, hh])).rows;
    expect(await verify(l, h)).toEqual([
      {
        token_id: id,
        user_id: bruce,
        scope: 'write',
        kind: 'personal',
        mfa: true,
        expires_at: null,
      },
    ]);
    expect(
      (
        await own<{ last_used_at: Date | null }>(
          'SELECT last_used_at FROM public.api_tokens WHERE id = $1',
          [id],
        )
      )[0]?.last_used_at,
    ).not.toBeNull();
    expect(await verify(l, hash())).toEqual([]);
    expect(await verify(lookup(), h)).toEqual([]);
    await own(
      `UPDATE public.api_tokens SET revoked_at = now(), revoked_reason = 'user' WHERE id = $1`,
      [id],
    );
    expect(await verify(l, h)).toEqual([]);
  });

  it('kept.token_oauth_grant() and token_oauth_for(): one live grant per client, updated in place', async () => {
    const client = 'https://claude.example/.well-known/client.json';
    const grant = (scope: Scope, forUser: string, locations: string[], s = 'read') =>
      as(
        scope,
        async (c) =>
          (
            await c.query<{ id: string }>(
              `SELECT kept.token_oauth_grant($1, $2, $3, $4, 'Claude') AS id`,
              [forUser, client, s, locations],
            )
          ).rows[0]?.id,
      );
    const first = await grant(user(bruce), bruce, [ibrahim.locationId]);
    const again = await grant(user(bruce), bruce, [garage.locationId], 'write');
    expect(again).toBe(first);
    expect(await tokenRow(first as string)).toMatchObject({
      revoked_at: null,
      locations: [garage.locationId],
    });
    expect((await pgError(grant(user(louis), bruce, [ibrahim.locationId]))).code).toBe('42501');
    expect((await pgError(grant(user(louis), louis, [garage.locationId]))).code).toBe('42501');
    expect(
      (await pgError(grant(viaToken(bruce, first as string), bruce, [garage.locationId]))).code,
    ).toBe('42501');

    const forUnscoped = (
      await db.pools.app.query('SELECT * FROM kept.token_oauth_for($1, $2)', [bruce, client])
    ).rows;
    expect(forUnscoped).toEqual([{ token_id: first, scope: 'write', mfa: true }]);
    expect(
      (
        await pgError(
          as(user(louis), (c) =>
            c.query('SELECT * FROM kept.token_oauth_for($1, $2)', [bruce, client]),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(await thingsIn(viaToken(bruce, first as string, true), garage.locationId)).toBe(1);
  });

  it('kept.token_rate_hit(): counts a minute per token and kind, and only your own token', async () => {
    const read = await token(bruce, 'read', [ibrahim.locationId]);
    const sql = `SELECT * FROM kept.token_rate_hit($1, 'read', 2)`;
    // One transaction, so one now() and one minute.
    const hits = await as(viaToken(bruce, read), async (c) => [
      (await c.query(sql, [read])).rows[0],
      (await c.query(sql, [read])).rows[0],
      (await c.query(sql, [read])).rows[0],
    ]);
    expect(hits.slice(0, 2)).toEqual([
      { ok: true, retry_after: 0 },
      { ok: true, retry_after: 0 },
    ]);
    expect(hits[2]?.ok).toBe(false);
    expect(hits[2]?.retry_after).toBeGreaterThanOrEqual(1);
    // Before a scope exists (the request's first step), and as its own user.
    expect((await db.pools.app.query(sql, [read])).rowCount).toBe(1);
    expect((await as(user(bruce), (c) => c.query(sql, [read]))).rowCount).toBe(1);
    expect((await pgError(as(user(louis), (c) => c.query(sql, [read])))).code).toBe('42501');
    await own(`UPDATE public.token_rate_windows SET minute = minute - interval '3 hours'`);
    const pruned = await withSystem(
      db.pools.system,
      async (_tx, c) =>
        (
          await c.query(
            `SELECT removed FROM kept.prune_stale_rows() WHERE what = 'token_rate_windows'`,
          )
        ).rows[0],
    );
    expect(Number(pruned?.removed)).toBeGreaterThanOrEqual(1);
    expect(await own('SELECT 1 FROM public.token_rate_windows')).toEqual([]);
  });
});
