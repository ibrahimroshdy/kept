import { newId } from '@kept/shared';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  asOwner,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { type Scope, withScope, withSystem } from './scope.js';

// Task 10: fail-closed row-level security (engineering spec §7.1, §7.2, §7.14; D178, D190).
// Everything here runs as kept_app (or kept_system) through withScope()/withSystem().

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string, mfa = false): Scope => ({ userId, mfa });

/** Runs one query as `scope` on kept_app and returns its rows. */
async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

/** Runs one statement as `scope` on kept_app and returns its row count. */
async function n(scope: Scope, text: string, values: unknown[] = []): Promise<number> {
  return withScope(
    app,
    scope,
    async (_tx, client) => (await client.query(text, values)).rowCount ?? 0,
  );
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('the membership functions', () => {
  it('compile, and admin_location_ids() keeps only owner and admin locations', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const c = await seedTenant(db, 'c');
    await addMember(db, b.locationId, a.userId, 'admin');
    await addMember(db, c.locationId, a.userId, 'member');
    const rows = await q<{ visible: string[]; writable: string[]; admin: string[] }>(
      as(a.userId),
      `SELECT ARRAY(SELECT kept.visible_location_ids() ORDER BY 1)::text[] AS visible,
              ARRAY(SELECT kept.writable_location_ids() ORDER BY 1)::text[] AS writable,
              ARRAY(SELECT kept.admin_location_ids() ORDER BY 1)::text[] AS admin`,
    );
    const sorted = (...x: string[]) => [...x].sort();
    expect(rows[0]).toEqual({
      visible: sorted(a.locationId, b.locationId, c.locationId),
      writable: sorted(a.locationId, b.locationId, c.locationId),
      admin: sorted(a.locationId, b.locationId),
    });
  });

  it('are SECURITY DEFINER with a fixed search_path, owned by kept_owner', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'kept' AND p.proname IN
            ('visible_location_ids', 'writable_location_ids', 'admin_location_ids',
             'current_owner_account_id', 'is_instance_admin', 'owns_location', 'fellow_member_ids')`,
      ),
    );
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row).toMatchObject({
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, public'],
        owner: 'kept_owner',
      });
    }
  });
});

describe('fail closed', () => {
  it('returns nothing, not an error, when no scope is set', async () => {
    await seedTenant(db, 'a');
    for (const table of ['locations', 'memberships', 'places', 'user_profiles', 'owner_accounts']) {
      const direct = await app.query(`SELECT * FROM public.${table}`);
      expect(direct.rows, table).toEqual([]);
    }
    // withSystem on the app pool: a transaction, but still no user.
    const inTx = await withSystem(
      app,
      async (_tx, c) => (await c.query('SELECT * FROM public.locations')).rows,
    );
    expect(inTx).toEqual([]);
  });

  it('refuses writes when no scope is set', async () => {
    const a = await seedTenant(db, 'a');
    const update = await app.query(`UPDATE public.places SET name = 'x'`);
    expect(update.rowCount).toBe(0);
    const insert = await pgError(
      app.query(`INSERT INTO public.places (location_id, name) VALUES ($1, 'x')`, [a.locationId]),
    );
    expect(insert.code).toBe('42501');
    const audit = await pgError(
      app.query(
        `INSERT INTO public.audit_events (actor_type, action, entity_type) VALUES ('system', 'x', 'y')`,
      ),
    );
    expect(audit.code).toBe('42501');
  });

  it('shows a user no row at all for a user id that has no memberships', async () => {
    await seedTenant(db, 'a');
    expect(await q(as(newId()), 'SELECT * FROM public.locations')).toEqual([]);
  });
});

describe('location scope', () => {
  let a: Tenant;
  let b: Tenant;

  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    b = await seedTenant(db, 'b');
  });

  it("shows a user only their own locations and those locations' rows", async () => {
    expect(ids(await q(as(a.userId), 'SELECT id FROM public.locations'))).toEqual([a.locationId]);
    expect(ids(await q(as(a.userId), 'SELECT id FROM public.places'))).toEqual([a.unplacedId]);
    const members = await q<{ user_id: string }>(
      as(a.userId),
      'SELECT user_id FROM public.memberships',
    );
    expect(members.map((m) => m.user_id)).toEqual([a.userId]);
  });

  it("lets a viewer read but not write the location's rows", async () => {
    const viewer = await seedUser(db, 'v');
    await addMember(db, a.locationId, viewer, 'viewer');
    expect(ids(await q(as(viewer), 'SELECT id FROM public.places'))).toEqual([a.unplacedId]);
    expect(await n(as(viewer), `UPDATE public.places SET name = 'x'`)).toBe(0);
    expect(await n(as(viewer), 'DELETE FROM public.places')).toBe(0);
    const insert = await pgError(
      n(as(viewer), `INSERT INTO public.places (location_id, name) VALUES ($1, 'x')`, [
        a.locationId,
      ]),
    );
    expect(insert.code).toBe('42501');
    // A member can.
    const member = await seedUser(db, 'm');
    await addMember(db, a.locationId, member, 'member');
    expect(await n(as(member), `UPDATE public.places SET name = 'Somewhere'`)).toBe(1);
  });

  it('hides a require_2fa location until the session has passed a second factor (§7.14)', async () => {
    const guarded = await seedTenant(db, 'g', { require2fa: true });
    const member = await seedUser(db, 'm');
    await addMember(db, guarded.locationId, member, 'member');
    for (const user of [member, guarded.userId]) {
      expect(await q(as(user, false), 'SELECT id FROM public.locations')).toEqual([]);
      expect(await q(as(user, false), 'SELECT id FROM public.places')).toEqual([]);
      expect(ids(await q(as(user, true), 'SELECT id FROM public.locations'))).toEqual([
        guarded.locationId,
      ]);
    }
  });

  it('shows nothing through an expired membership', async () => {
    const member = await seedUser(db, 'm');
    await addMember(db, a.locationId, member, 'member', new Date(Date.now() - 1000));
    expect(await q(as(member), 'SELECT id FROM public.locations')).toEqual([]);
    expect(await q(as(member), 'SELECT id FROM public.places')).toEqual([]);
    expect(await n(as(member), `UPDATE public.places SET name = 'x'`)).toBe(0);
    // Still in date: visible.
    const later = await seedUser(db, 'l');
    await addMember(db, a.locationId, later, 'member', new Date(Date.now() + 86_400_000));
    expect(ids(await q(as(later), 'SELECT id FROM public.locations'))).toEqual([a.locationId]);
  });

  it('hides a location in its deletion grace period, even from its owner (D149)', async () => {
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.locations SET deleted_at = now(), purge_after = now() + interval '30 days'
          WHERE id = $1`,
        [a.locationId],
      ),
    );
    expect(await q(as(a.userId), 'SELECT id FROM public.locations')).toEqual([]);
    expect(await q(as(a.userId), 'SELECT id FROM public.places')).toEqual([]);
  });

  it('lets an owner soft-delete a location through kept.delete_location(), and restore it (D149)', async () => {
    const [deleted0] = await q<{ purge_after: Date }>(
      as(a.userId),
      'SELECT kept.delete_location($1) AS purge_after',
      [a.locationId],
    );
    const days = ((deleted0?.purge_after.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(await q(as(a.userId), 'SELECT id FROM public.locations')).toEqual([]);
    // The owner still finds it, for the restore screen; nobody else does.
    const deleted = await q<{ id: string; name: string }>(
      as(a.userId),
      'SELECT id, name FROM kept.deleted_locations()',
    );
    expect(deleted).toEqual([{ id: a.locationId, name: 'Home' }]);
    expect(await q(as(b.userId), 'SELECT id FROM kept.deleted_locations()')).toEqual([]);
    // Deleting it again finds nothing to delete.
    expect(
      (await pgError(q(as(a.userId), 'SELECT kept.delete_location($1)', [a.locationId]))).code,
    ).toBe('42501');
    await q(as(a.userId), 'SELECT kept.restore_location($1)', [a.locationId]);
    expect(ids(await q(as(a.userId), 'SELECT id FROM public.locations'))).toEqual([a.locationId]);
    const row = await asOwner(db, (c) =>
      c.query('SELECT deleted_at, purge_after FROM public.locations WHERE id = $1', [a.locationId]),
    );
    expect(row.rows[0]).toEqual({ deleted_at: null, purge_after: null });
  });

  it('keeps a Personal location undeletable, and a lapsed grace period unrestorable', async () => {
    const p = await seedTenant(db, 'p', { kind: 'personal' });
    const personal = await pgError(
      q(as(p.userId), 'SELECT kept.delete_location($1)', [p.locationId]),
    );
    expect(personal).toMatchObject({ code: '23514', constraint: 'locations_personal_undeletable' });
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.locations SET deleted_at = now() - interval '31 days',
                purge_after = now() - interval '1 day' WHERE id = $1`,
        [a.locationId],
      ),
    );
    expect(await q(as(a.userId), 'SELECT id FROM kept.deleted_locations()')).toEqual([]);
    const late = await pgError(q(as(a.userId), 'SELECT kept.restore_location($1)', [a.locationId]));
    expect(late.code).toBe('42501');
  });

  it('keeps delete, restore, successor and require_2fa away from admins (review #4, D165)', async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    // Straight UPDATEs of the owner-only columns: no column grant.
    for (const set of [
      'deleted_at = now()',
      "purge_after = now() + interval '1 day'",
      'successor_user_id = $2',
      'require_2fa = true',
    ]) {
      const values = set.includes('$2') ? [a.locationId, admin] : [a.locationId];
      const err = await pgError(
        n(as(admin), `UPDATE public.locations SET ${set} WHERE id = $1`, values),
      );
      expect(err.code, set).toBe('42501');
    }
    // The definer paths check ownership.
    for (const [text, values] of [
      ['SELECT kept.delete_location($1)', [a.locationId]],
      ['SELECT kept.set_location_successor($1, $2)', [a.locationId, admin]],
      ['SELECT kept.set_location_require_2fa($1, true)', [a.locationId]],
    ] as const) {
      expect((await pgError(q(as(admin), text, [...values]))).code, text).toBe('42501');
    }
    await q(as(a.userId), 'SELECT kept.delete_location($1)', [a.locationId]);
    expect(await q(as(admin), 'SELECT id FROM kept.deleted_locations()')).toEqual([]);
    expect(
      (await pgError(q(as(admin), 'SELECT kept.restore_location($1)', [a.locationId]))).code,
    ).toBe('42501');
  });

  it('lets the owner name a member as successor and require two-factor (D165, §7.14)', async () => {
    const member = await seedUser(db, 'm');
    await addMember(db, a.locationId, member, 'member');
    await q(as(a.userId), 'SELECT kept.set_location_successor($1, $2)', [a.locationId, member]);
    // Someone who isn't a member can't be named.
    const outsider = await pgError(
      q(as(a.userId), 'SELECT kept.set_location_successor($1, $2)', [a.locationId, b.userId]),
    );
    expect(outsider.code).toBe('42501');
    await q(as(a.userId), 'SELECT kept.set_location_require_2fa($1, true)', [a.locationId]);
    const row = await asOwner(db, (c) =>
      c.query('SELECT successor_user_id, require_2fa FROM public.locations WHERE id = $1', [
        a.locationId,
      ]),
    );
    expect(row.rows[0]).toEqual({ successor_user_id: member, require_2fa: true });
    // Now the location needs a second factor, for its owner too.
    const without = await pgError(
      q(as(a.userId), 'SELECT kept.set_location_successor($1, NULL)', [a.locationId]),
    );
    expect(without.code).toBe('42501');
    await q(as(a.userId, true), 'SELECT kept.set_location_successor($1, NULL)', [a.locationId]);
  });

  it("answers a place-loop probe into another tenant's tree like any other id (review #2)", async () => {
    // B: parent P with child C.
    const parent = newId();
    const child = newId();
    await ownerTx(db, async (c) => {
      await c.query(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'P')`, [
        parent,
        b.locationId,
      ]);
      await c.query(
        `INSERT INTO public.places (id, location_id, parent_id, name) VALUES ($1, $2, $3, 'C')`,
        [child, b.locationId, parent],
      );
    });
    // A inserts into A's own location a place under C, with an id that is C's ancestor in B...
    const probe = (id: string) =>
      pgError(
        n(
          as(a.userId),
          `INSERT INTO public.places (id, location_id, parent_id, name) VALUES ($1, $2, $3, 'x')`,
          [id, a.locationId, child],
        ),
      );
    const ancestor = await probe(parent);
    // ...and one that isn't. The two answers must be the same: before the fix the first was
    // places_no_loop, read off B's tree by a SECURITY DEFINER walk.
    const unrelated = await probe(b.unplacedId);
    expect(ancestor.code).not.toBe('23514');
    expect({ code: ancestor.code, constraint: ancestor.constraint }).toEqual({
      code: unrelated.code,
      constraint: unrelated.constraint,
    });
  });

  it('refuses moving any row to another tenant through an id or scope column (review #5)', async () => {
    // A is also an admin in B, so RLS alone would let every one of these through: both
    // locations are writable. The column grants are what stop a row changing tenant.
    await addMember(db, b.locationId, a.userId, 'admin');
    const room = newId();
    await n(
      as(a.userId),
      `INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'Room')`,
      [room, a.locationId],
    );
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.invites (location_id, role, token_hash, expires_at, created_by)
         VALUES ($1, 'member', $2, now() + interval '1 day', $3)`,
        [a.locationId, `hash-${newId()}`, a.userId],
      );
      await c.query(
        `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'money', true)`,
        [a.locationId],
      );
      await c.query(
        `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id) VALUES ($1, 'place', $2)`,
        [a.locationId, newId()],
      );
    });
    for (const [text, values] of [
      ['UPDATE public.places SET location_id = $1 WHERE id = $2', [b.locationId, room]],
      ['UPDATE public.places SET id = $1 WHERE id = $2', [newId(), room]],
      [
        'UPDATE public.invites SET location_id = $1 WHERE location_id = $2',
        [b.locationId, a.locationId],
      ],
      [
        'UPDATE public.location_modules SET location_id = $1 WHERE location_id = $2',
        [b.locationId, a.locationId],
      ],
      [
        'UPDATE public.sync_tombstones SET location_id = $1 WHERE location_id = $2',
        [b.locationId, a.locationId],
      ],
    ] as const) {
      expect((await pgError(n(as(a.userId), text, [...values]))).code, text).toBe('42501');
    }
  });

  it('refuses a place, module or tombstone written into a location the user cannot write', async () => {
    for (const [text, values] of [
      [`INSERT INTO public.places (location_id, name) VALUES ($1, 'x')`, [b.locationId]],
      [
        `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'money', true)`,
        [b.locationId],
      ],
      [
        `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id) VALUES ($1, 'place', $2)`,
        [b.locationId, newId()],
      ],
    ] as const) {
      const err = await pgError(n(as(a.userId), text, [...values]));
      expect(err.code, text).toBe('42501');
    }
  });

  it("refuses moving a place into another tenant's location", async () => {
    const room = newId();
    await n(
      as(a.userId),
      `INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'Room')`,
      [room, a.locationId],
    );
    const err = await pgError(
      n(as(a.userId), 'UPDATE public.places SET location_id = $1 WHERE id = $2', [
        b.locationId,
        room,
      ]),
    );
    expect(err.code).toBe('42501');
  });
});

describe('creating an account: the ensureAccount() order (§7.14, task 18)', () => {
  it('works in one kept_app transaction: account, location, owner membership, Unplaced, profile', async () => {
    const userId = await ownerTx(db, async (c) => {
      const id = newId();
      await c.query(`INSERT INTO auth."user" (id, name, email) VALUES ($1, 'N', $2)`, [
        id,
        `${id}@example.test`,
      ]);
      return id;
    });
    const accountId = newId();
    const locationId = newId();
    await withScope(app, as(userId), async (_tx, c) => {
      await c.query('INSERT INTO public.owner_accounts (id, user_id) VALUES ($1, $2)', [
        accountId,
        userId,
      ]);
      // No RETURNING: the new location isn't visible until its membership exists.
      await c.query(
        `INSERT INTO public.locations (id, owner_account_id, kind, name, timezone, currency, preset)
         VALUES ($1, $2, 'personal', 'Personal', 'Africa/Cairo', 'EGP', 'household')`,
        [locationId, accountId],
      );
      await c.query(
        `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [locationId, userId],
      );
      await c.query(
        `INSERT INTO public.places (location_id, name, is_unplaced) VALUES ($1, 'Unplaced', true)`,
        [locationId],
      );
      await c.query(`INSERT INTO public.user_profiles (user_id, display_name) VALUES ($1, 'N')`, [
        userId,
      ]);
    });
    expect(ids(await q(as(userId), 'SELECT id FROM public.locations'))).toEqual([locationId]);
    expect(ids(await q(as(userId), 'SELECT id FROM public.owner_accounts'))).toEqual([accountId]);
  });

  it('fails a location INSERT … RETURNING before its membership exists (use client ids)', async () => {
    const userId = await seedUser(db, 'n');
    const err = await pgError(
      withScope(app, as(userId), async (_tx, c) => {
        const accountId = newId();
        await c.query('INSERT INTO public.owner_accounts (id, user_id) VALUES ($1, $2)', [
          accountId,
          userId,
        ]);
        await c.query(
          `INSERT INTO public.locations (owner_account_id, kind, name, timezone, currency)
           VALUES ($1, 'personal', 'P', 'UTC', 'EGP') RETURNING id`,
          [accountId],
        );
      }),
    );
    expect(err.code).toBe('42501');
  });

  it("refuses a location under someone else's owner account, or a second account", async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const loc = await pgError(
      n(
        as(a.userId),
        `INSERT INTO public.locations (owner_account_id, kind, name, timezone, currency)
         VALUES ($1, 'home', 'X', 'UTC', 'EGP')`,
        [b.accountId],
      ),
    );
    expect(loc.code).toBe('42501');
    const acct = await pgError(
      n(as(a.userId), 'INSERT INTO public.owner_accounts (user_id) VALUES ($1)', [b.userId]),
    );
    expect(acct.code).toBe('42501');
  });

  it('commits nothing when the owner membership is missing (deferred check)', async () => {
    const a = await seedTenant(db, 'a');
    const err = await pgError(
      n(
        as(a.userId),
        `INSERT INTO public.locations (owner_account_id, kind, name, timezone, currency)
         VALUES ($1, 'home', 'Lonely', 'UTC', 'EGP')`,
        [a.accountId],
      ),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'locations_owner_membership' });
  });
});

describe('memberships', () => {
  let a: Tenant;
  let b: Tenant;

  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    b = await seedTenant(db, 'b');
  });

  it("refuses an owner membership in a location the user doesn't own", async () => {
    const err = await pgError(
      n(
        as(a.userId),
        `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [b.locationId, a.userId],
      ),
    );
    expect(err.code).toBe('42501');
  });

  it('lets an admin change and remove members, never an owner or their own row', async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin', new Date(Date.now() + 86_400_000));
    const newcomer = await seedUser(db, 'new');
    // No later than the admin's own end (D180, 0010): an admin can't touch a membership that
    // outlasts theirs.
    await addMember(db, a.locationId, newcomer, 'member', new Date(Date.now() + 3_600_000));
    expect(
      await n(as(admin), `UPDATE public.memberships SET role = 'viewer' WHERE user_id = $1`, [
        newcomer,
      ]),
    ).toBe(1);
    // The owner's row is out of an admin's reach: no demoting, removing or replacing the owner.
    expect(
      await n(as(admin), `UPDATE public.memberships SET expires_at = now() WHERE role = 'owner'`),
    ).toBe(0);
    expect(await n(as(admin), `DELETE FROM public.memberships WHERE role = 'owner'`)).toBe(0);
    // No making anyone owner: the new row fails the policy's check.
    const promote = await pgError(
      n(as(admin), `UPDATE public.memberships SET role = 'owner' WHERE user_id = $1`, [newcomer]),
    );
    expect(promote.code).toBe('42501');
    // Nor themselves: their own row is out of reach altogether.
    expect(
      await n(as(admin), `UPDATE public.memberships SET role = 'owner' WHERE user_id = $1`, [
        admin,
      ]),
    ).toBe(0);
    // Nor their own row: an admin can't lift their own expiry (review #4).
    expect(
      await n(as(admin), 'UPDATE public.memberships SET expires_at = NULL WHERE user_id = $1', [
        admin,
      ]),
    ).toBe(0);
    expect(
      await n(as(admin), 'DELETE FROM public.memberships WHERE user_id = $1', [newcomer]),
    ).toBe(1);
  });

  it('lets anyone but the owner leave: delete their own row, and nobody else’s (task 19)', async () => {
    const viewer = await seedUser(db, 'viewer');
    const member = await seedUser(db, 'member');
    await addMember(db, a.locationId, viewer, 'viewer');
    await addMember(db, a.locationId, member, 'member');
    // A viewer can't remove anyone else…
    expect(await n(as(viewer), 'DELETE FROM public.memberships WHERE user_id = $1', [member])).toBe(
      0,
    );
    // …and the owner can't leave by deleting their own row.
    expect(
      await n(as(a.userId), 'DELETE FROM public.memberships WHERE user_id = $1', [a.userId]),
    ).toBe(0);
    expect(await n(as(viewer), 'DELETE FROM public.memberships WHERE user_id = $1', [viewer])).toBe(
      1,
    );
    // Only a visible membership can be left: a hidden (require_2fa) location is left after
    // enrolling a second factor.
    await ownerTx(db, (c) =>
      c.query('UPDATE public.locations SET require_2fa = true WHERE id = $1', [a.locationId]),
    );
    expect(await n(as(member), 'DELETE FROM public.memberships WHERE user_id = $1', [member])).toBe(
      0,
    );
    expect(
      await n(as(member, true), 'DELETE FROM public.memberships WHERE user_id = $1', [member]),
    ).toBe(1);
  });

  it('refuses every direct membership insert but the owner creating their own (review #1)', async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    const insert = (user: string, role = 'member') =>
      pgError(
        n(
          as(admin),
          'INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, $3)',
          [a.locationId, user, role],
        ),
      );
    // B's user, a user id that exists nowhere, and the admin's own row again: all the same
    // refusal. Before the fix the first went in (and made B's profile readable until rollback),
    // and the second answered with a foreign-key error, telling auth users apart.
    for (const user of [b.userId, newId()]) {
      expect((await insert(user)).code, user).toBe('42501');
    }
    expect((await insert(b.userId, 'viewer')).code).toBe('42501');
    // The owner can't insert other people either.
    const byOwner = await pgError(
      n(
        as(a.userId),
        `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'member')`,
        [a.locationId, b.userId],
      ),
    );
    expect(byOwner.code).toBe('42501');
    expect(
      await q(as(admin), 'SELECT user_id FROM public.user_profiles WHERE user_id = $1', [b.userId]),
    ).toEqual([]);
  });

  it('pins invited_by on the owner self-insert (review, minor)', async () => {
    const accountId = newId();
    const locationId = newId();
    const userId = await seedUser(db, 'solo');
    const err = await pgError(
      withScope(app, as(userId), async (_tx, c) => {
        await c.query('INSERT INTO public.owner_accounts (id, user_id) VALUES ($1, $2)', [
          accountId,
          userId,
        ]);
        await c.query(
          `INSERT INTO public.locations (id, owner_account_id, kind, name, timezone, currency)
           VALUES ($1, $2, 'home', 'H', 'UTC', 'EGP')`,
          [locationId, accountId],
        );
        await c.query(
          `INSERT INTO public.memberships (location_id, user_id, role, invited_by)
           VALUES ($1, $2, 'owner', $3)`,
          [locationId, userId, a.userId],
        );
      }),
    );
    expect(err.code).toBe('42501');
  });

  it('refuses member and viewer changes to memberships', async () => {
    const member = await seedUser(db, 'm');
    await addMember(db, a.locationId, member, 'member');
    const other = await seedUser(db, 'o');
    const err = await pgError(
      n(
        as(member),
        `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'viewer')`,
        [a.locationId, other],
      ),
    );
    expect(err.code).toBe('42501');
    expect(await n(as(member), `UPDATE public.memberships SET role = 'admin'`)).toBe(0);
  });

  it('refuses moving a membership to another location or user (column grants)', async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    for (const text of [
      'UPDATE public.memberships SET location_id = $1 WHERE user_id = $2',
      'UPDATE public.memberships SET user_id = $1 WHERE user_id = $2',
    ]) {
      const err = await pgError(n(as(admin), text, [b.locationId, admin]));
      expect(err.code, text).toBe('42501');
    }
  });

  it("refuses an admin taking over the location's owner account (column grants)", async () => {
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    const err = await pgError(
      n(as(admin), 'UPDATE public.locations SET owner_account_id = $1 WHERE id = $2', [
        b.accountId,
        a.locationId,
      ]),
    );
    expect(err.code).toBe('42501');
  });
});

describe('user scope', () => {
  it('shows profiles of the user and of fellow members only', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const c = await seedTenant(db, 'c');
    await addMember(db, a.locationId, b.userId, 'viewer');
    const seen = await q<{ user_id: string }>(
      as(a.userId),
      'SELECT user_id FROM public.user_profiles',
    );
    expect(seen.map((r) => r.user_id).sort()).toEqual([a.userId, b.userId].sort());
    expect(seen.map((r) => r.user_id)).not.toContain(c.userId);
    // A fellow's profile is read-only.
    expect(
      await n(
        as(a.userId),
        `UPDATE public.user_profiles SET display_name = 'x' WHERE user_id = $1`,
        [b.userId],
      ),
    ).toBe(0);
    expect(
      await n(as(a.userId), `UPDATE public.user_profiles SET theme = 'dark' WHERE user_id = $1`, [
        a.userId,
      ]),
    ).toBe(1);
  });

  it('refuses a user flipping their own managed flag (column grants)', async () => {
    const a = await seedTenant(db, 'a');
    const err = await pgError(
      n(as(a.userId), 'UPDATE public.user_profiles SET managed = true WHERE user_id = $1', [
        a.userId,
      ]),
    );
    expect(err.code).toBe('42501');
  });

  it('refuses a profile a user inserts as managed, or as created by someone (review, minor)', async () => {
    const a = await seedTenant(db, 'a');
    const fresh = await ownerTx(db, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO auth."user" (id, name, email) VALUES (uuidv7(), 'f', 'f-' || uuidv7() || '@example.test')
         RETURNING id`,
      ),
    ).then((r) => r.rows[0]?.id as string);
    const insert = (managed: boolean, createdBy: string | null) =>
      n(
        as(fresh),
        `INSERT INTO public.user_profiles (user_id, display_name, managed, created_by_user_id)
         VALUES ($1, 'F', $2, $3)`,
        [fresh, managed, createdBy],
      );
    expect((await pgError(insert(true, null))).code).toBe('42501');
    expect((await pgError(insert(false, a.userId))).code).toBe('42501');
    expect(await insert(false, null)).toBe(1);
  });

  it('pins an invite to its creator, unaccepted (review, minor)', async () => {
    const a = await seedTenant(db, 'a');
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    const insert = (createdBy: string, acceptedBy: string | null) =>
      n(
        as(admin),
        `INSERT INTO public.invites (location_id, role, token_hash, expires_at, created_by, accepted_by)
         VALUES ($1, 'member', $2, now() + interval '7 days', $3, $4)`,
        [a.locationId, `hash-${newId()}`, createdBy, acceptedBy],
      );
    expect((await pgError(insert(a.userId, null))).code).toBe('42501');
    expect((await pgError(insert(admin, admin))).code).toBe('42501');
    expect(await insert(admin, null)).toBe(1);
  });

  it('shows only the own owner account, idempotency keys and hidden modules', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    await n(
      as(b.userId),
      `INSERT INTO public.idempotency_keys (user_id, key, request_hash) VALUES ($1, 'k', 'h')`,
      [b.userId],
    );
    await n(
      as(b.userId),
      `INSERT INTO public.user_hidden_modules (user_id, location_id, module) VALUES ($1, $2, 'money')`,
      [b.userId, b.locationId],
    );
    expect(ids(await q(as(a.userId), 'SELECT id FROM public.owner_accounts'))).toEqual([
      a.accountId,
    ]);
    expect(await q(as(a.userId), 'SELECT * FROM public.idempotency_keys')).toEqual([]);
    expect(await q(as(a.userId), 'SELECT * FROM public.user_hidden_modules')).toEqual([]);
    const spoof = await pgError(
      n(
        as(a.userId),
        `INSERT INTO public.idempotency_keys (user_id, key, request_hash) VALUES ($1, 'k2', 'h')`,
        [b.userId],
      ),
    );
    expect(spoof.code).toBe('42501');
    // Hiding a module needs the location to be visible to the user, not just their own user id.
    const hide = await pgError(
      n(
        as(a.userId),
        `INSERT INTO public.user_hidden_modules (user_id, location_id, module) VALUES ($1, $2, 'money')`,
        [a.userId, b.locationId],
      ),
    );
    expect(hide.code).toBe('42501');
  });
});

describe('instance scope (§7.14, D190)', () => {
  it('lets an instance admin read and write instance_settings; others see 0 rows', async () => {
    const a = await seedTenant(db, 'a');
    const admin = await seedUser(db, 'root');
    await ownerTx(db, async (c) => {
      await c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin]);
      await c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ('signup_open', 'false')`,
      );
    });
    expect(await q(as(admin), 'SELECT key FROM public.instance_settings')).toEqual([
      { key: 'signup_open' },
    ]);
    expect(
      await n(
        as(admin),
        `UPDATE public.instance_settings SET value = 'true' WHERE key = 'signup_open'`,
      ),
    ).toBe(1);
    expect(await q(as(a.userId), 'SELECT key FROM public.instance_settings')).toEqual([]);
    expect(await n(as(a.userId), `UPDATE public.instance_settings SET value = 'true'`)).toBe(0);
    const grant = await pgError(
      n(as(a.userId), 'INSERT INTO public.instance_admins (user_id) VALUES ($1)', [a.userId]),
    );
    expect(grant.code).toBe('42501');
    // Admins see every admin row; a user sees at most their own.
    expect(await q(as(a.userId), 'SELECT user_id FROM public.instance_admins')).toEqual([]);
    expect(await q(as(admin), 'SELECT user_id FROM public.instance_admins')).toEqual([
      { user_id: admin },
    ]);
    // An instance admin is not a member: no location is visible (D33).
    expect(await q(as(admin), 'SELECT id FROM public.locations')).toEqual([]);
  });
});

describe('audit_events', () => {
  it("shows a location's events to its members, and account events to the account holder", async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const viewer = await seedUser(db, 'v');
    await addMember(db, a.locationId, viewer, 'viewer');
    await ownerTx(db, async (c) => {
      const ins = `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, action, entity_type)
                   VALUES ($1, $2, 'user', $3, 'x')`;
      await c.query(ins, [a.locationId, null, 'a-loc']);
      await c.query(ins, [null, a.accountId, 'a-acct']);
      await c.query(ins, [b.locationId, null, 'b-loc']);
      await c.query(ins, [null, b.accountId, 'b-acct']);
    });
    const actions = async (user: string) =>
      (await q<{ action: string }>(as(user), 'SELECT action FROM public.audit_events'))
        .map((r) => r.action)
        .sort();
    expect(await actions(a.userId)).toEqual(['a-acct', 'a-loc']);
    expect(await actions(viewer)).toEqual(['a-loc']);
    expect(await actions(b.userId)).toEqual(['b-acct', 'b-loc']);
  });

  it('lets a viewer write events for a visible location, never for another tenant', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const viewer = await seedUser(db, 'v');
    await addMember(db, a.locationId, viewer, 'viewer');
    const ins = `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action, entity_type)
                 VALUES ($1, $2, 'user', $3, 'reveal', 'thing')`;
    expect(await n(as(viewer), ins, [a.locationId, null, viewer])).toBe(1);
    expect(await n(as(viewer), ins, [a.locationId, a.accountId, viewer])).toBe(1);
    for (const values of [
      [b.locationId, null, viewer],
      [a.locationId, b.accountId, viewer],
      [null, b.accountId, viewer],
      [null, a.accountId, viewer],
    ]) {
      const err = await pgError(n(as(viewer), ins, values));
      expect(err.code, JSON.stringify(values)).toBe('42501');
    }
    // Append-only for kept_app: no UPDATE privilege at all, and no DELETE policy.
    expect(
      (await pgError(n(as(a.userId), `UPDATE public.audit_events SET action = 'x'`))).code,
    ).toBe('42501');
    expect(await n(as(a.userId), 'DELETE FROM public.audit_events')).toBe(0);
  });

  it('pins the actor to the signed-in user (review #3)', async () => {
    const a = await seedTenant(db, 'a');
    const viewer = await seedUser(db, 'v');
    await addMember(db, a.locationId, viewer, 'viewer');
    const ins = `INSERT INTO public.audit_events (location_id, actor_type, actor_id, action, entity_type)
                 VALUES ($1, $2, $3, 'delete', 'thing')`;
    for (const [type, actor] of [
      ['system', null],
      ['system', viewer],
      ['token', viewer],
      ['user', a.userId],
      ['user', null],
    ] as const) {
      const err = await pgError(n(as(viewer), ins, [a.locationId, type, actor]));
      expect(err.code, `${type} ${actor}`).toBe('42501');
    }
    expect(await n(as(viewer), ins, [a.locationId, 'user', viewer])).toBe(1);
  });

  it('keeps instance-level events (no location, no account) to instance admins (review #3)', async () => {
    const a = await seedTenant(db, 'a');
    const root = await seedUser(db, 'root');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [root]),
    );
    const ins = `INSERT INTO public.audit_events (actor_type, actor_id, action, entity_type)
                 VALUES ('user', $1, 'settings.update', 'instance')`;
    expect((await pgError(n(as(a.userId), ins, [a.userId]))).code).toBe('42501');
    expect(await n(as(root), ins, [root])).toBe(1);
  });

  it('keeps undo fields to the 7-day window and to undoable events in the same place (review #3)', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const own = newId();
    const theirs = newId();
    await n(
      as(a.userId),
      `INSERT INTO public.audit_events (id, location_id, actor_type, actor_id, action, entity_type, undoable_until)
       VALUES ($1, $2, 'user', $3, 'place.move', 'place', now() + interval '1 day')`,
      [own, a.locationId, a.userId],
    );
    await n(
      as(b.userId),
      `INSERT INTO public.audit_events (id, location_id, actor_type, actor_id, action, entity_type, undoable_until)
       VALUES ($1, $2, 'user', $3, 'place.move', 'place', now() + interval '1 day')`,
      [theirs, b.locationId, b.userId],
    );
    const ins = (undoOf: string | null, until: string | null) =>
      n(
        as(a.userId),
        `INSERT INTO public.audit_events
           (location_id, actor_type, actor_id, action, entity_type, undo_of, undoable_until)
         VALUES ($1, 'user', $2, 'place.move', 'place', $3, now() + $4::interval)`,
        [a.locationId, a.userId, undoOf, until],
      );
    for (const until of ['8 days', '-1 minute']) {
      expect(await pgError(ins(null, until)), until).toMatchObject({
        code: '23514',
        constraint: 'audit_events_undo_window',
      });
    }
    for (const undoOf of [theirs, newId()]) {
      expect(await pgError(ins(undoOf, null)), undoOf).toMatchObject({
        code: '23514',
        constraint: 'audit_events_undo_of',
      });
    }
    expect(await ins(null, '7 days')).toBe(1);
    expect(await ins(own, null)).toBe(1);
  });

  it("attaches subjects only to the user's own events (review #3)", async () => {
    const a = await seedTenant(db, 'a');
    const viewer = await seedUser(db, 'v');
    await addMember(db, a.locationId, viewer, 'viewer');
    const event = async (user: string) => {
      const id = newId();
      const at = await withScope(app, as(user), async (_tx, c) => {
        await c.query(
          `INSERT INTO public.audit_events (id, at, location_id, actor_type, actor_id, action, entity_type)
           VALUES ($1, date_trunc('milliseconds', now()), $2, 'user', $3, 'x', 'thing')`,
          [id, a.locationId, user],
        );
        return (await c.query(`SELECT date_trunc('milliseconds', now()) AS at`)).rows[0].at;
      });
      return { id, at };
    };
    const owners = await event(a.userId);
    const mine = await event(viewer);
    const sub = (e: { id: string; at: Date }) =>
      n(
        as(viewer),
        `INSERT INTO public.audit_event_subjects (event_id, event_at, location_id, thing_id)
         VALUES ($1, $2, $3, $4)`,
        [e.id, e.at, a.locationId, newId()],
      );
    expect((await pgError(sub(owners))).code).toBe('42501');
    expect(await sub(mine)).toBe(1);
  });
});

describe('kept_system', () => {
  it('reads the tables its step-1 jobs need, across tenants, and nothing else', async () => {
    await seedTenant(db, 'a');
    await seedTenant(db, 'b');
    const count = (table: string) =>
      withSystem(db.pools.system, async (_tx, c) => {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.${table}`);
        return rows[0].n as number;
      });
    expect(await count('memberships')).toBe(2);
    expect(await count('owner_accounts')).toBe(2);
    expect(await count('user_profiles')).toBe(2);
    // Since 0053 (step-4 T6) the reminder scan reads every location's agenda: locations and
    // places among them, SELECT only (test/leak.test.ts SYSTEM_READ_TABLES). Nothing it doesn't
    // need: invites, audit subjects, files.
    expect(await count('places')).toBe(2);
    expect(await count('locations')).toBe(2);
    expect(await count('invites')).toBe(0);
    expect(await count('files')).toBe(0);
    // Reading isn't writing: no policy lets it change a row.
    const write = await withSystem(
      db.pools.system,
      async (_tx, c) => (await c.query(`UPDATE public.locations SET name = name`)).rowCount,
    ).catch((err: { code?: string }) => err.code);
    expect([0, '42501']).toContain(write);
  });

  it('reads, inserts and deletes audit rows, and never updates one (review, minor)', async () => {
    const a = await seedTenant(db, 'a');
    const sys = <T>(text: string, values: unknown[] = []) =>
      withSystem(db.pools.system, async (_tx, c) => (await c.query(text, values)).rowCount as T);
    expect(
      await sys(
        `INSERT INTO public.audit_events (location_id, actor_type, action, entity_type)
         VALUES ($1, 'system', 'membership.expire', 'membership')`,
        [a.locationId],
      ),
    ).toBe(1);
    expect((await pgError(sys(`UPDATE public.audit_events SET action = 'x'`))).code).toBe('42501');
    expect(await sys('DELETE FROM public.audit_events')).toBe(1);
  });
});

describe('through Drizzle', () => {
  it('applies the same policies to a Drizzle query in scope', async () => {
    const a = await seedTenant(db, 'a');
    await seedTenant(db, 'b');
    const rows = await withScope(app, as(a.userId), (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM public.locations`),
    );
    expect(rows.rows.map((r) => r.id)).toEqual([a.locationId]);
  });
});

describe('security review of tasks 19–21 (migration 0010)', () => {
  let a: Tenant;
  let admin: string;
  let member: string;
  const DAY = 86_400_000;

  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    admin = await seedUser(db, 'admin');
    member = await seedUser(db, 'member');
    await addMember(db, a.locationId, admin, 'admin', new Date(Date.now() + 10 * DAY));
    await addMember(db, a.locationId, member, 'member', new Date(Date.now() + DAY));
  });

  it("keeps admins and their rows the owner's alone (D48): no promoting, editing or removing", async () => {
    const other = await seedUser(db, 'other-admin');
    await addMember(db, a.locationId, other, 'admin', new Date(Date.now() + DAY));
    const promote = await pgError(
      n(as(admin), `UPDATE public.memberships SET role = 'admin' WHERE user_id = $1`, [member]),
    );
    expect(promote.code).toBe('42501');
    expect(
      await n(as(admin), `UPDATE public.memberships SET role = 'member' WHERE user_id = $1`, [
        other,
      ]),
    ).toBe(0);
    expect(
      await n(as(admin), 'UPDATE public.memberships SET expires_at = now() WHERE user_id = $1', [
        other,
      ]),
    ).toBe(0);
    expect(await n(as(admin), 'DELETE FROM public.memberships WHERE user_id = $1', [other])).toBe(
      0,
    );
    // The owner may do all of it.
    expect(
      await n(as(a.userId), `UPDATE public.memberships SET role = 'admin' WHERE user_id = $1`, [
        member,
      ]),
    ).toBe(1);
    expect(
      await n(as(a.userId), 'DELETE FROM public.memberships WHERE user_id = $1', [other]),
    ).toBe(1);
    // An admin still leaves on their own (0008 app_delete_own).
    expect(await n(as(admin), 'DELETE FROM public.memberships WHERE user_id = $1', [admin])).toBe(
      1,
    );
  });

  it("caps an admin's end dates at their own (D180)", async () => {
    const past = await pgError(
      n(as(admin), 'UPDATE public.memberships SET expires_at = $2 WHERE user_id = $1', [
        member,
        new Date(Date.now() + 30 * DAY),
      ]),
    );
    expect(past.code).toBe('42501');
    const none = await pgError(
      n(as(admin), 'UPDATE public.memberships SET expires_at = NULL WHERE user_id = $1', [member]),
    );
    expect(none.code).toBe('42501');
    expect(
      await n(as(admin), 'UPDATE public.memberships SET expires_at = $2 WHERE user_id = $1', [
        member,
        new Date(Date.now() + 5 * DAY),
      ]),
    ).toBe(1);
    // The owner has no end date, so no cap.
    expect(
      await n(as(a.userId), 'UPDATE public.memberships SET expires_at = NULL WHERE user_id = $1', [
        member,
      ]),
    ).toBe(1);
  });

  it('lets nobody edit an invite: revoking is a DELETE', async () => {
    const { rows } = await ownerTx(db, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO public.invites (location_id, role, token_hash, expires_at, created_by)
         VALUES ($1, 'member', $2, now() + interval '7 days', $3) RETURNING id`,
        [a.locationId, `hash-${newId()}`, a.userId],
      ),
    );
    const inviteId = rows[0]?.id;
    for (const who of [admin, a.userId]) {
      const err = await pgError(
        n(as(who), `UPDATE public.invites SET role = 'admin' WHERE id = $1`, [inviteId]),
      );
      expect(err.code, who).toBe('42501');
    }
  });

  it('keeps module switches to owners and admins', async () => {
    const insert = (who: string) =>
      n(
        as(who),
        `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'money', true)
         ON CONFLICT (location_id, module) DO UPDATE SET enabled = NOT location_modules.enabled`,
        [a.locationId],
      );
    expect((await pgError(insert(member))).code).toBe('42501');
    expect(await insert(admin)).toBe(1);
    expect(
      await n(as(member), 'DELETE FROM public.location_modules WHERE location_id = $1', [
        a.locationId,
      ]),
    ).toBe(0);
  });

  it('refuses a managed account creating a location (D47)', async () => {
    const kid = await seedTenant(db, 'kid');
    await ownerTx(db, (c) =>
      c.query('UPDATE public.user_profiles SET managed = true WHERE user_id = $1', [kid.userId]),
    );
    const err = await pgError(
      n(
        as(kid.userId),
        `INSERT INTO public.locations (owner_account_id, kind, name, timezone, currency)
         VALUES ($1, 'home', 'Mine', 'UTC', 'EGP')`,
        [kid.accountId],
      ),
    );
    expect(err.code).toBe('42501');
  });

  it("refuses naming a home location on one's own profile", async () => {
    const solo = await ownerTx(db, async (c) => {
      const id = newId();
      await c.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [
        id,
        'solo',
        `solo-${id}@example.test`,
      ]);
      return id;
    });
    const err = await pgError(
      n(
        as(solo),
        `INSERT INTO public.user_profiles (user_id, display_name, created_in_location_id)
         VALUES ($1, 'Solo', $2)`,
        [solo, a.locationId],
      ),
    );
    expect(err.code).toBe('42501');
  });
});
