import { newId } from '@kept/shared';
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
import { type Scope, withScope } from './scope.js';

// Task 8: the secret store (engineering spec §1.3, §7.3, §7.13; D116, D177). As kept_app.

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string): Scope => ({ userId, mfa: false });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

async function field(typeKey: string, key: string) {
  const { rows } = await asOwner(db, (c) =>
    c.query(
      `SELECT f.id FROM public.type_fields f JOIN public.types t ON t.id = f.type_id
        WHERE t.builtin_key = $1 AND f.key = $2`,
      [typeKey, key],
    ),
  );
  return rows[0].id as string;
}

/** Writes a secret value as `userId` (no RETURNING: a writer may not be able to read it). */
const write = (userId: string, t: Tenant, thingId: string, fieldId: string, key: string, c = 'x') =>
  withScope(app, as(userId), async (_tx, client) =>
    client.query(
      `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key,
                                         ciphertext, key_version, updated_by)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [t.locationId, thingId, fieldId, key, JSON.stringify({ c }), userId],
    ),
  );

describe('secret values (D116, D177)', () => {
  let a: Tenant;
  let admin: string;
  let member: string;
  let router: string;
  let wifi: string;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    admin = await seedUser(db, 'admin');
    member = await seedUser(db, 'member');
    await addMember(db, a.locationId, admin, 'admin');
    await addMember(db, a.locationId, member, 'member');
    wifi = await field('network_device', 'wifi_password');
    router = newId();
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.things (id, location_id, place_id, name, type_id)
         VALUES ($1, $2, $3, 'Router', (SELECT id FROM public.types WHERE builtin_key = 'network_device'))`,
        [router, a.locationId, a.unplacedId],
      ),
    );
  });

  const reveal = (userId: string) =>
    q(
      as(userId),
      `SELECT ciphertext->>'c' AS c FROM public.secret_values
        WHERE thing_id = $1 AND superseded_at IS NULL`,
      [router],
    ).then((r) => r.map((x) => x.c));
  const canReveal = (userId: string) =>
    q<{ ok: boolean }>(as(userId), 'SELECT kept.can_reveal_secret($1, $2) AS ok', [
      a.locationId,
      wifi,
    ]).then((r) => r[0]?.ok);

  it('reveals to owners and admins by default; to members once the policy names them', async () => {
    await write(a.userId, a, router, wifi, 'wifi_password', 'hunter2');
    expect(await canReveal(a.userId)).toBe(true);
    expect(await canReveal(admin)).toBe(true);
    expect(await canReveal(member)).toBe(false);
    expect(await reveal(member)).toEqual([]);
    await q(
      as(a.userId),
      `INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles)
       VALUES ($1, $2, ARRAY['owner', 'admin', 'member'])`,
      [a.locationId, wifi],
    );
    expect(await reveal(member)).toEqual(['hunter2']);
  });

  it('reveals to a user the policy names, whatever their role', async () => {
    await write(a.userId, a, router, wifi, 'wifi_password', 'hunter2');
    await q(
      as(a.userId),
      `INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles, reveal_user_ids)
       VALUES ($1, $2, ARRAY['owner'], ARRAY[$3::uuid])`,
      [a.locationId, wifi, member],
    );
    expect(await canReveal(member)).toBe(true);
    expect(await canReveal(admin)).toBe(false);
  });

  it('lets a member write and supersede a secret they cannot read back', async () => {
    await write(member, a, router, wifi, 'wifi_password', 'one');
    await write(member, a, router, wifi, 'wifi_password', 'two');
    expect(await reveal(member)).toEqual([]);
    expect(await reveal(a.userId)).toEqual(['two']);
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT ciphertext->>'c' AS c, superseded_at IS NOT NULL AS old FROM public.secret_values
          WHERE thing_id = $1 ORDER BY created_at, old DESC`,
        [router],
      ),
    );
    expect(rows).toEqual([
      { c: 'one', old: true },
      { c: 'two', old: false },
    ]);
    // Which fields are set, without values, for anyone who can see the thing.
    expect(
      await q(as(member), 'SELECT field_key, can_reveal FROM kept.secret_fields_set($1, NULL)', [
        router,
      ]),
    ).toEqual([{ field_key: 'wifi_password', can_reveal: false }]);
  });

  it('clearing erases: every version of the field loses its ciphertext, keeping the rows', async () => {
    const spare = newId();
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.things (id, location_id, place_id, name, type_id)
         VALUES ($1, $2, $3, 'Spare router',
                 (SELECT id FROM public.types WHERE builtin_key = 'network_device'))`,
        [spare, a.locationId, a.unplacedId],
      ),
    );
    await write(member, a, router, wifi, 'wifi_password', 'one');
    await write(member, a, router, wifi, 'wifi_password', 'two');
    await write(member, a, spare, wifi, 'wifi_password', 'keep-me');
    const cleared = await q<{ v: boolean }>(
      as(member),
      `SELECT kept.clear_secret($1, NULL, 'wifi_password') AS v`,
      [router],
    );
    expect(cleared).toEqual([{ v: true }]);
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT thing_id = $1 AS cleared, ciphertext, key_version,
                superseded_at IS NOT NULL AS old
           FROM public.secret_values WHERE thing_id = ANY ($2::uuid[])
          ORDER BY thing_id = $1, created_at`,
        [router, [router, spare]],
      ),
    );
    expect(rows).toEqual([
      { cleared: false, ciphertext: { c: 'keep-me' }, key_version: 1, old: false },
      { cleared: true, ciphertext: null, key_version: 1, old: true },
      { cleared: true, ciphertext: null, key_version: 1, old: true },
    ]);
    // Clearing again finds no current value, and a new value is written as usual.
    expect(
      await q(as(member), `SELECT kept.clear_secret($1, NULL, 'wifi_password') AS v`, [router]),
    ).toEqual([{ v: false }]);
    await write(member, a, router, wifi, 'wifi_password', 'three');
    expect(await reveal(a.userId)).toEqual(['three']);
  });

  it('refuses a viewer, and a value written in someone else’s name, before superseding anything', async () => {
    const viewer = await seedUser(db, 'viewer');
    await addMember(db, a.locationId, viewer, 'viewer');
    await write(a.userId, a, router, wifi, 'wifi_password', 'keep');
    expect((await pgError(write(viewer, a, router, wifi, 'wifi_password', 'bad'))).code).toBe(
      '42501',
    );
    const forged = withScope(app, as(member), async (_tx, client) =>
      client.query(
        `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key,
                                           ciphertext, key_version, updated_by)
         VALUES ($1, $2, $3, 'wifi_password', '{"c": "bad"}', 1, $4)`,
        [a.locationId, router, wifi, a.userId],
      ),
    );
    expect((await pgError(forged)).code).toBe('42501');
    expect(await reveal(a.userId)).toEqual(['keep']);
  });

  it('refuses a field that is not secret, or whose key differs', async () => {
    const plain = await field('computer', 'cpu');
    expect(await pgError(write(a.userId, a, router, plain, 'cpu'))).toMatchObject({
      code: '42501',
      constraint: 'secret_field',
    });
    expect(await pgError(write(a.userId, a, router, wifi, 'other'))).toMatchObject({
      code: '23514',
      constraint: 'secret_values_field_key',
    });
  });

  it('never updates or deletes a value through kept_app', async () => {
    await write(a.userId, a, router, wifi, 'wifi_password');
    for (const sql of [
      `UPDATE public.secret_values SET ciphertext = '{}' WHERE thing_id = $1`,
      'DELETE FROM public.secret_values WHERE thing_id = $1',
    ]) {
      expect((await pgError(q(as(a.userId), sql, [router]))).code).toBe('42501');
    }
  });

  it('never reaches custom or the search document', async () => {
    await write(a.userId, a, router, wifi, 'wifi_password', 'hunter2');
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT custom::text, search_tsv::text FROM public.things WHERE id = $1', [router]),
    );
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });

  it("lets only the location's owner write its policies (D177)", async () => {
    const insert = (userId: string) =>
      q(
        as(userId),
        `INSERT INTO public.secret_field_policies (location_id, type_field_id) VALUES ($1, $2)`,
        [a.locationId, wifi],
      );
    expect((await pgError(insert(admin))).code).toBe('42501');
    await insert(a.userId);
    expect(
      await q(as(admin), 'UPDATE public.secret_field_policies SET ai_allowed = true RETURNING 1'),
    ).toEqual([]);
    // A field that isn't secret can have no policy.
    const plain = await field('computer', 'cpu');
    expect(
      (
        await pgError(
          q(
            as(a.userId),
            `INSERT INTO public.secret_field_policies (location_id, type_field_id) VALUES ($1, $2)`,
            [a.locationId, plain],
          ),
        )
      ).constraint,
    ).toBe('secret_field');
  });
});
