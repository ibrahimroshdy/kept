import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  asOwner,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
} from '../../test/tenancy.js';

// Task 9: the tenancy schema as kept_owner (engineering spec §1.2, §7.4, §7.13, §7.14).

const db = await testDb();

beforeEach(async () => {
  await db.reset();
});

describe('reference data', () => {
  it('seeds the five supported currencies (D136)', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query(
        'SELECT code, minor_units, enabled FROM public.currencies WHERE enabled ORDER BY code',
      ),
    );
    expect(rows).toEqual(
      ['CAD', 'EGP', 'EUR', 'GBP', 'USD'].map((code) => ({ code, minor_units: 2, enabled: true })),
    );
  });

  it('refuses a location in a currency that is not in the table', async () => {
    const t = await seedTenant(db, 'a');
    const err = await pgError(
      asOwner(db, (c) =>
        c.query(
          `INSERT INTO public.locations (owner_account_id, kind, name, timezone, currency)
           VALUES ($1, 'home', 'X', 'UTC', 'XYZ')`,
          [t.accountId],
        ),
      ),
    );
    expect(err).toMatchObject({
      code: '23503',
      constraint: 'locations_currency_currencies_code_fk',
    });
  });
});

describe('locations', () => {
  it('allows one personal location per owner account', async () => {
    const t = await seedTenant(db, 'a', { kind: 'personal' });
    const err = await pgError(ownerTx(db, (c) => insertLocation(c, t, { kind: 'personal' })));
    expect(err).toMatchObject({ code: '23505', constraint: 'locations_one_personal_uq' });
  });

  it('rejects enum values outside the list (text + CHECK, D183)', async () => {
    const t = await seedTenant(db, 'a');
    const err = await pgError(ownerTx(db, (c) => insertLocation(c, t, { kind: 'castle' })));
    expect(err).toMatchObject({ code: '23514', constraint: 'locations_kind_chk' });
  });

  it('bumps row_version and change_seq on update, and stamps change_seq on insert', async () => {
    const t = await seedTenant(db, 'a');
    await asOwner(db, async (c) => {
      const before = await c.query(
        'SELECT row_version, change_seq, updated_at FROM public.locations WHERE id = $1',
        [t.locationId],
      );
      expect(before.rows[0].row_version).toBe(1);
      expect(before.rows[0].change_seq).not.toBeNull();

      await c.query(`UPDATE public.locations SET name = 'Renamed' WHERE id = $1`, [t.locationId]);
      const after = await c.query(
        'SELECT row_version, change_seq, updated_at FROM public.locations WHERE id = $1',
        [t.locationId],
      );
      expect(after.rows[0].row_version).toBe(2);
      expect(BigInt(after.rows[0].change_seq)).toBeGreaterThan(BigInt(before.rows[0].change_seq));
      expect(after.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(
        before.rows[0].updated_at.getTime(),
      );
    });
  });

  it('has the touch_row trigger on every table with a row_version column', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ table_name: string; has_trigger: boolean }>(
        `SELECT c.table_name,
                EXISTS (SELECT 1 FROM pg_trigger t
                         WHERE t.tgrelid = format('public.%I', c.table_name)::regclass
                           AND t.tgfoid = 'kept.touch_row()'::regprocedure
                           AND NOT t.tgisinternal) AS has_trigger
           FROM information_schema.columns c
           JOIN pg_class k ON k.relname = c.table_name
           JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
          WHERE c.table_schema = 'public' AND c.column_name = 'row_version'
            AND NOT k.relispartition`,
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.filter((r) => !r.has_trigger).map((r) => r.table_name)).toEqual([]);
  });
});

describe('ownership consistency (deferred, §7.13)', () => {
  it('commits the ensureAccount() order: location, then its owner membership, in one transaction', async () => {
    const t = await seedTenant(db, 'a');
    const { locationId } = await ownerTx(db, (c) => insertLocation(c, t));
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT role, user_id FROM public.memberships WHERE location_id = $1', [locationId]),
    );
    expect(rows).toEqual([{ role: 'owner', user_id: t.userId }]);
  });

  it('refuses at COMMIT, not before, a location with no owner membership', async () => {
    const t = await seedTenant(db, 'a');
    await asOwner(db, async (c) => {
      await c.query('BEGIN');
      // The statement itself succeeds: the check is deferred.
      await c.query(
        `INSERT INTO public.locations (owner_account_id, kind, name, timezone, currency)
         VALUES ($1, 'home', 'Orphan', 'UTC', 'USD')`,
        [t.accountId],
      );
      const err = await pgError(c.query('COMMIT'));
      expect(err).toMatchObject({ code: '23514', constraint: 'locations_owner_membership' });
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM public.locations WHERE name = 'Orphan'`,
      );
      expect(rows[0].n).toBe(0);
    });
  });

  it("refuses an owner membership held by someone other than the account's user", async () => {
    const t = await seedTenant(db, 'a');
    const other = await seedUser(db, 'b');
    const err = await pgError(
      ownerTx(db, async (c) => {
        const id = newId();
        await c.query(
          `INSERT INTO public.locations (id, owner_account_id, kind, name, timezone, currency)
           VALUES ($1, $2, 'home', 'X', 'UTC', 'USD')`,
          [id, t.accountId],
        );
        await c.query(
          `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [id, other],
        );
      }),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'locations_owner_membership' });
  });

  it('refuses removing or demoting the owner membership', async () => {
    const t = await seedTenant(db, 'a');
    const del = await pgError(
      ownerTx(db, (c) =>
        c.query(`DELETE FROM public.memberships WHERE location_id = $1`, [t.locationId]),
      ),
    );
    expect(del).toMatchObject({ code: '23514', constraint: 'locations_owner_membership' });
    const demote = await pgError(
      ownerTx(db, (c) =>
        c.query(`UPDATE public.memberships SET role = 'admin' WHERE location_id = $1`, [
          t.locationId,
        ]),
      ),
    );
    expect(demote).toMatchObject({ code: '23514', constraint: 'locations_owner_membership' });
  });

  it('refuses moving a location to another owner account without moving the owner membership', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const err = await pgError(
      ownerTx(db, (c) =>
        c.query('UPDATE public.locations SET owner_account_id = $1 WHERE id = $2', [
          b.accountId,
          a.locationId,
        ]),
      ),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'locations_owner_membership' });
  });

  it('refuses a second member on a personal location (§1.2)', async () => {
    const t = await seedTenant(db, 'a', { kind: 'personal' });
    const other = await seedUser(db, 'b');
    const err = await pgError(
      ownerTx(db, (c) =>
        c.query(
          `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'member')`,
          [t.locationId, other],
        ),
      ),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'locations_personal_owner_only' });
  });

  it('allows a hard delete of a location with everything in it (purge)', async () => {
    const t = await seedTenant(db, 'a');
    await ownerTx(db, (c) => c.query('DELETE FROM public.locations WHERE id = $1', [t.locationId]));
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT count(*)::int AS n FROM public.memberships WHERE location_id = $1', [
        t.locationId,
      ]),
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses deleting an auth user whose account still owns a location', async () => {
    const t = await seedTenant(db, 'a');
    const err = await pgError(
      ownerTx(db, (c) => c.query('DELETE FROM auth."user" WHERE id = $1', [t.userId])),
    );
    expect(err.code).toBe('23001'); // restrict_violation
  });
});

describe('places (§7.13)', () => {
  async function place(locationId: string, parentId: string | null, name: string) {
    const id = newId();
    await ownerTx(db, (c) =>
      c.query(
        'INSERT INTO public.places (id, location_id, parent_id, name) VALUES ($1, $2, $3, $4)',
        [id, locationId, parentId, name],
      ),
    );
    return id;
  }

  it('refuses a loop', async () => {
    const t = await seedTenant(db, 'a');
    const room = await place(t.locationId, null, 'Room');
    const shelf = await place(t.locationId, room, 'Shelf');
    const box = await place(t.locationId, shelf, 'Box');
    const err = await pgError(
      ownerTx(db, (c) =>
        c.query('UPDATE public.places SET parent_id = $1 WHERE id = $2', [box, room]),
      ),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'places_no_loop' });
    const self = await pgError(
      ownerTx(db, (c) => c.query('UPDATE public.places SET parent_id = $1 WHERE id = $1', [room])),
    );
    expect(self.code).toBe('23514');
  });

  it('refuses a parent in another location (composite foreign key)', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const bRoom = await place(b.locationId, null, 'B room');
    const err = await pgError(place(a.locationId, bRoom, 'Sneaky'));
    expect(err).toMatchObject({ code: '23503', constraint: 'places_parent_fk' });
  });

  it('carries location_id down to children when a parent moves (ON UPDATE CASCADE)', async () => {
    const a = await seedTenant(db, 'a');
    const second = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Garage' }));
    const room = await place(a.locationId, null, 'Room');
    const shelf = await place(a.locationId, room, 'Shelf');
    await ownerTx(db, (c) =>
      c.query('UPDATE public.places SET location_id = $1 WHERE id = $2', [second.locationId, room]),
    );
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT location_id FROM public.places WHERE id = $1', [shelf]),
    );
    expect(rows[0].location_id).toBe(second.locationId);
  });

  it('refuses a parent that still has children being deleted (ON DELETE NO ACTION, plan Q12)', async () => {
    const a = await seedTenant(db, 'a');
    const room = await place(a.locationId, null, 'Room');
    await place(a.locationId, room, 'Shelf');
    const err = await pgError(
      ownerTx(db, (c) => c.query('DELETE FROM public.places WHERE id = $1', [room])),
    );
    // NO ACTION since step 2 (0015): checked at statement end, so a cascade can remove both.
    expect(err).toMatchObject({ code: '23503', constraint: 'places_parent_fk' });
  });

  it('allows one Unplaced area per location, and it cannot be trashed or re-parented', async () => {
    const a = await seedTenant(db, 'a');
    const room = await place(a.locationId, null, 'Room');
    const second = await pgError(
      ownerTx(db, (c) =>
        c.query(
          `INSERT INTO public.places (location_id, name, is_unplaced) VALUES ($1, 'Again', true)`,
          [a.locationId],
        ),
      ),
    );
    expect(second).toMatchObject({ code: '23505', constraint: 'places_one_unplaced_uq' });

    for (const sql of [
      'UPDATE public.places SET deleted_at = now() WHERE id = $1',
      'UPDATE public.places SET is_unplaced = false WHERE id = $1',
    ]) {
      const err = await pgError(ownerTx(db, (c) => c.query(sql, [a.unplacedId])));
      expect(err).toMatchObject({ code: '23514', constraint: 'places_unplaced_fixed' });
    }
    const reparent = await pgError(
      ownerTx(db, (c) =>
        c.query('UPDATE public.places SET parent_id = $1 WHERE id = $2', [room, a.unplacedId]),
      ),
    );
    expect(reparent.code).toBe('23514');
    const promote = await pgError(
      ownerTx(db, (c) =>
        c.query('UPDATE public.places SET is_unplaced = true WHERE id = $1', [room]),
      ),
    );
    expect(promote.code).toMatch(/^23/);
    // Renaming it is fine.
    await ownerTx(db, (c) =>
      c.query(`UPDATE public.places SET name = 'Somewhere' WHERE id = $1`, [a.unplacedId]),
    );
  });
});

describe('audit_events (§7.13)', () => {
  it('is partitioned by month, with a default partition and this month and three more', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'public.audit_events'::regclass ORDER BY 1`,
      ),
    );
    const month = (offset: number) => {
      const d = new Date();
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
      return `audit_events_${m.getUTCFullYear()}_${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    expect(rows.map((r) => r.name)).toEqual(
      ['audit_events_default', month(0), month(1), month(2), month(3)].sort(),
    );
  });

  it('indexes account-level events (no location) by account and time', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_events_account_at_idx'`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(
      /\(owner_account_id, at DESC NULLS LAST\) WHERE \(location_id IS NULL\)/,
    );
  });

  it('indexes events rooted at a thing on every partition, and on partitions made later', async () => {
    const attached = (c: pg.ClientBase) =>
      c.query<{ part: string; def: string }>(
        `SELECT t.relname AS part, pg_get_indexdef(i.inhrelid) AS def
           FROM pg_inherits i
           JOIN pg_index x ON x.indexrelid = i.inhrelid
           JOIN pg_class t ON t.oid = x.indrelid
          WHERE i.inhparent = 'public.audit_events_root_thing_idx'::regclass
          ORDER BY 1`,
      );
    await asOwner(db, async (c) => {
      const { rows: parent } = await c.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_events_root_thing_idx'`,
      );
      expect(parent).toHaveLength(1);
      expect(parent[0].indexdef).toMatch(
        /\(root_thing_id, at DESC NULLS LAST\) WHERE \(root_thing_id IS NOT NULL\)/,
      );
      const { rows: parts } = await c.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'public.audit_events'::regclass ORDER BY 1`,
      );
      const before = (await attached(c)).rows;
      expect(before.map((r) => r.part)).toEqual(parts.map((p) => p.name));
      // A partition made later (the maintenance job's door) inherits it; rolled back, so the
      // partition list above stays this month and three more.
      await c.query('BEGIN');
      try {
        await c.query(`SELECT kept.create_audit_partition('2099-01-01')`);
        const after = (await attached(c)).rows;
        expect(after.find((r) => r.part === 'audit_events_2099_01')?.def).toMatch(
          /\(root_thing_id, at DESC NULLS LAST\) WHERE \(root_thing_id IS NOT NULL\)/,
        );
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it("routes an event to its month, and keeps a subject in its event's location", async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO public.audit_events (location_id, actor_type, actor_id, action, entity_type)
         VALUES ($1, 'user', $2, 'create', 'place') RETURNING id, at, tableoid::regclass::text AS part`,
        [a.locationId, a.userId],
      );
      expect(rows[0].part).toMatch(/^audit_events_\d{4}_\d{2}$/);
      await c.query(
        `INSERT INTO public.audit_event_subjects (event_id, event_at, location_id, thing_id)
         VALUES ($1, $2, $3, $4)`,
        [rows[0].id, rows[0].at, a.locationId, newId()],
      );
      const err = await pgError(
        c.query(
          `INSERT INTO public.audit_event_subjects (event_id, event_at, location_id, thing_id)
           VALUES ($1, $2, $3, $4)`,
          [rows[0].id, rows[0].at, b.locationId, newId()],
        ),
      );
      expect(err).toMatchObject({ code: '23503', constraint: 'audit_event_subjects_event_fk' });
    });
  });

  it('keeps kept_app and kept_system off the partitions themselves', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT c.relname,
                has_table_privilege('kept_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app,
                has_table_privilege('kept_system', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS sys,
                c.relrowsecurity AND c.relforcerowsecurity AS rls
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'public.audit_events'::regclass`,
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row).toMatchObject({ app: false, sys: false, rls: true });
  });
});

describe('users', () => {
  it('cascades a deleted auth user with no locations to its profile', async () => {
    const userId = await seedUser(db, 'solo');
    await ownerTx(db, (c) => c.query('DELETE FROM auth."user" WHERE id = $1', [userId]));
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT count(*)::int AS n FROM public.user_profiles WHERE user_id = $1', [userId]),
    );
    expect(rows[0].n).toBe(0);
  });
});
