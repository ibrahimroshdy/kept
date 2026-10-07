import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { addMember, ownerTx, pgError, seedTenant, seedUser } from '../../test/tenancy.js';
import { type Scope, withScope } from './scope.js';

// Task 4: account scope for the registries (§1.1, D123), the recovery-kit gate for writers
// (D193, Q24), registry history at account level (Q15), and the currency switch (D168).

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

const accounts = (scope: Scope) =>
  q<{ visible: string[]; writable: string[]; admin: string[] }>(
    scope,
    `SELECT ARRAY(SELECT kept.visible_account_ids() ORDER BY 1)::text[] AS visible,
            ARRAY(SELECT kept.writable_account_ids() ORDER BY 1)::text[] AS writable,
            ARRAY(SELECT kept.admin_account_ids() ORDER BY 1)::text[] AS admin`,
  ).then((r) => r[0]);

describe('kept.visible_account_ids(), writable_account_ids(), admin_account_ids()', () => {
  it('follow the locations of each account the user can reach, by role', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const c = await seedTenant(db, 'c');
    const d = await seedTenant(db, 'd');
    await addMember(db, b.locationId, a.userId, 'admin');
    await addMember(db, c.locationId, a.userId, 'member');
    await addMember(db, d.locationId, a.userId, 'viewer');
    const sorted = (...x: string[]) => [...x].sort();
    expect(await accounts(as(a.userId))).toEqual({
      visible: sorted(a.accountId, b.accountId, c.accountId, d.accountId),
      writable: sorted(a.accountId, b.accountId, c.accountId),
      admin: sorted(a.accountId, b.accountId),
    });
  });

  it('drop an account whose only reachable location is expired, deleted or needs a second factor', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const g = await seedTenant(db, 'g', { require2fa: true });
    await addMember(db, b.locationId, a.userId, 'admin', new Date(Date.now() - 60_000));
    await addMember(db, g.locationId, a.userId, 'admin');
    expect(await accounts(as(a.userId))).toEqual({
      visible: [a.accountId],
      writable: [a.accountId],
      admin: [a.accountId],
    });
    expect((await accounts(as(a.userId, true)))?.admin).toContain(g.accountId);
  });

  it('return nothing without a scope, and are refused to kept_system', async () => {
    await seedTenant(db, 'a');
    const { rows } = await app.query('SELECT count(*)::int AS n FROM kept.visible_account_ids()');
    expect(rows[0].n).toBe(0);
    const err = await pgError(db.pools.system.query('SELECT kept.admin_account_ids()'));
    expect(err.code).toBe('42501');
  });
});

describe('kept.recovery_kit_acknowledged()', () => {
  it('answers whether an instance admin acknowledged the kit, for any signed-in user', async () => {
    const a = await seedTenant(db, 'a');
    const ask = async () =>
      (await q<{ ok: boolean }>(as(a.userId), 'SELECT kept.recovery_kit_acknowledged() AS ok'))[0]
        ?.ok;
    expect(await ask()).toBe(false);
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.instance_settings (key, value)
         VALUES ('recovery_kit_acknowledged_at', to_jsonb(now()))`,
      ),
    );
    expect(await ask()).toBe(true);
  });
});

describe('registry history at account level (Q15)', () => {
  // No RETURNING, as audited() writes (a writer need not be able to read the row back).
  const event = (accountId: string, userId: string, entityType: string) =>
    withScope(
      app,
      as(userId),
      async (_tx, c) =>
        (
          await c.query(
            `INSERT INTO public.audit_events
               (owner_account_id, actor_type, actor_id, action, entity_type, entity_id)
             VALUES ($1, 'user', $2, $3, $4, $5)`,
            [accountId, userId, `${entityType}.update`, entityType, newId()],
          )
        ).rowCount,
    );
  const readable = async (userId: string, accountId: string) =>
    (
      await q<{ n: number }>(
        as(userId),
        `SELECT count(*)::int AS n FROM public.audit_events
          WHERE location_id IS NULL AND owner_account_id = $1`,
        [accountId],
      )
    )[0]?.n;

  it("lets an admin of B's location (not its owner) write and read a brand event on B's account", async () => {
    const b = await seedTenant(db, 'b');
    const admin = await seedUser(db, 'admin-of-b');
    await addMember(db, b.locationId, admin, 'admin');
    expect(await event(b.accountId, admin, 'brand')).toBe(1);
    expect(await readable(admin, b.accountId)).toBe(1);
  });

  it("refuses that admin an account event on B's account, and hides B's own account events", async () => {
    const b = await seedTenant(db, 'b');
    const admin = await seedUser(db, 'admin-of-b');
    await addMember(db, b.locationId, admin, 'admin');
    expect((await pgError(event(b.accountId, admin, 'account'))).code).toBe('42501');
    await event(b.accountId, b.userId, 'account');
    expect(await readable(admin, b.accountId)).toBe(0);
    expect(await readable(b.userId, b.accountId)).toBe(1);
  });

  it('lets a member write a person, vendor or tag event, but not read registry history', async () => {
    const b = await seedTenant(db, 'b');
    const member = await seedUser(db, 'member-of-b');
    await addMember(db, b.locationId, member, 'member');
    for (const kind of ['person', 'vendor', 'tag']) {
      expect(await event(b.accountId, member, kind)).toBe(1);
    }
    expect(await readable(member, b.accountId)).toBe(0);
  });

  it('refuses a viewer both, and anyone with no location of the account', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const viewer = await seedUser(db, 'viewer-of-b');
    await addMember(db, b.locationId, viewer, 'viewer');
    await event(b.accountId, b.userId, 'brand');
    expect((await pgError(event(b.accountId, viewer, 'brand'))).code).toBe('42501');
    expect(await readable(viewer, b.accountId)).toBe(0);
    expect((await pgError(event(b.accountId, a.userId, 'brand'))).code).toBe('42501');
    expect(await readable(a.userId, b.accountId)).toBe(0);
  });
});

describe('currencies (D168)', () => {
  it('lets an instance admin switch one on or off, and nothing else of the row', async () => {
    const admin = await seedTenant(db, 'admin');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]),
    );
    const rows = await q(
      as(admin.userId),
      `UPDATE public.currencies SET enabled = true WHERE code = 'JPY' RETURNING code, enabled`,
    );
    expect(rows).toEqual([{ code: 'JPY', enabled: true }]);
    const err = await pgError(
      q(as(admin.userId), `UPDATE public.currencies SET minor_units = 3 WHERE code = 'JPY'`),
    );
    expect(err.code).toBe('42501');
  });

  it('changes nothing for anyone else', async () => {
    const a = await seedTenant(db, 'a');
    const rows = await q(
      as(a.userId),
      `UPDATE public.currencies SET enabled = true WHERE code = 'JPY' RETURNING code`,
    );
    expect(rows).toEqual([]);
  });
});
