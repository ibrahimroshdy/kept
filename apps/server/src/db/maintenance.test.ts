import { createHash } from 'node:crypto';
import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  asOwner,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope, withSystem } from './scope.js';

// Task 10: kept_system's maintenance doors (engineering spec §3.3, §7.4, §7.9; D149, D161, D162;
// plan Q12): reindexing a location, and purging the trash, deleted locations and orphan files.

const db = await testDb();

beforeEach(async () => {
  await db.reset();
});

async function own<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await asOwner(db, (c) => c.query<T>(text, values))).rows;
}

async function sys<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withSystem(db.pools.system, async (_tx, c) => (await c.query<T>(text, values)).rows);
}

type Loc = { locationId: string; unplacedId: string };

async function thing(
  loc: Loc,
  fields: { name?: string; containerId?: string; placeId?: string } = {},
) {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, container_id, name) VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      loc.locationId,
      fields.containerId ? null : (fields.placeId ?? loc.unplacedId),
      fields.containerId ?? null,
      fields.name ?? 'Thing',
    ],
  );
  return id;
}

async function file(loc: Loc, userId: string, opts: { key?: string; age?: string } = {}) {
  const id = newId();
  await own(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by, created_at)
     VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5, now() - $6::interval)`,
    [
      id,
      loc.locationId,
      opts.key ?? `f/${loc.locationId}/${id}`,
      createHash('sha256').update(id).digest('hex'),
      userId,
      opts.age ?? '2 days',
    ],
  );
  await own(
    `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height, bytes)
     VALUES ($1, 'thumb', $2, $3, 1, 1, 1)`,
    [id, loc.locationId, `d/${id}/thumb.jpg`],
  );
  return id;
}

describe('kept.reindex_location() (§7.9)', () => {
  it("refreshes the contents' paths after a container is renamed, without a row_version bump", async () => {
    const a = await seedTenant(db, 'a');
    const box = await thing(a, { name: 'Box' });
    const cable = await thing(a, { name: 'Cable', containerId: box });
    await own(`UPDATE public.things SET name = 'Blue box' WHERE id = $1`, [box]);
    const stale = await own<{ place_path: string; row_version: number }>(
      'SELECT place_path, row_version FROM public.things WHERE id = $1',
      [cable],
    );
    expect(stale[0]?.place_path).toBe('Unplaced › Box');
    const boxBefore = await own<{ change_seq: string }>(
      'SELECT change_seq FROM public.things WHERE id = $1',
      [box],
    );
    // Only the cable's caches change; the box is not rewritten (security review, performance).
    const [n] = await sys<{ n: number }>('SELECT kept.reindex_location($1) AS n', [a.locationId]);
    expect(n?.n).toBe(1);
    expect(await own('SELECT change_seq FROM public.things WHERE id = $1', [box])).toEqual(
      boxBefore,
    );
    expect(
      await own('SELECT place_path, row_version FROM public.things WHERE id = $1', [cable]),
    ).toEqual([{ place_path: 'Unplaced › Blue box', row_version: stale[0]?.row_version }]);
  });
});

describe('kept.purge_trash() (D162)', () => {
  let a: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  const trash = (id: string, days: number) =>
    own(`UPDATE public.things SET deleted_at = now() - make_interval(days => $2) WHERE id = $1`, [
      id,
      days,
    ]);

  it('purges a thing trashed 31 days ago: its code retires and a tombstone is left', async () => {
    const old = await thing(a, { name: 'Old' });
    const recent = await thing(a, { name: 'Recent' });
    const code = randomShortCode();
    await own('INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)', [
      code,
      a.locationId,
      old,
    ]);
    await trash(old, 31);
    await trash(recent, 5);
    const [n] = await sys<{ n: number }>(
      `SELECT kept.purge_trash(now() - interval '30 days', 100) AS n`,
    );
    expect(n?.n).toBe(1);
    expect(await own('SELECT id FROM public.things WHERE id = ANY ($1)', [[old, recent]])).toEqual([
      { id: recent },
    ]);
    expect(
      await own('SELECT state, location_id FROM public.short_ids WHERE code = $1', [code]),
    ).toEqual([{ state: 'retired', location_id: a.locationId }]);
    expect(
      await own(
        `SELECT 1 FROM public.sync_tombstones WHERE entity_type = 'thing' AND entity_id = $1`,
        [old],
      ),
    ).toHaveLength(1);
  });

  it('purges a trashed box after what is inside it, and keeps one that still holds something live', async () => {
    const box = await thing(a, { name: 'Box' });
    const inner = await thing(a, { name: 'Inner', containerId: box });
    const keep = await thing(a, { name: 'Keep' });
    const live = await thing(a, { name: 'Live', containerId: keep });
    for (const id of [box, inner, keep]) await trash(id, 40);
    const [n] = await sys<{ n: number }>(
      `SELECT kept.purge_trash(now() - interval '30 days', 100) AS n`,
    );
    expect(n?.n).toBe(2);
    expect(
      (
        await own<{ id: string }>('SELECT id FROM public.things WHERE id = ANY ($1)', [
          [box, inner, keep, live],
        ])
      )
        .map((r) => r.id)
        .sort(),
    ).toEqual([keep, live].sort());
  });

  it('purges trashed places with nothing left under them, and stops at the limit', async () => {
    const shed = newId();
    const rack = newId();
    await own(
      "INSERT INTO public.places (id, location_id, name, deleted_at) VALUES ($1, $2, $3, now() - interval '40 days')",
      [shed, a.locationId, 'Shed'],
    );
    await own(
      `INSERT INTO public.places (id, location_id, parent_id, name, deleted_at) VALUES ($1, $2, $3, 'Rack', now() - interval '40 days')`,
      [rack, a.locationId, shed],
    );
    const [one] = await sys<{ n: number }>(
      `SELECT kept.purge_trash(now() - interval '30 days', 1) AS n`,
    );
    expect(one?.n).toBe(1);
    expect(await own('SELECT id FROM public.places WHERE id = ANY ($1)', [[shed, rack]])).toEqual([
      { id: shed },
    ]);
    await sys(`SELECT kept.purge_trash(now() - interval '30 days', 10)`);
    expect(await own('SELECT id FROM public.places WHERE id = ANY ($1)', [[shed, rack]])).toEqual(
      [],
    );
  });
});

describe('kept.purge_deleted_locations() (D149)', () => {
  it('purges a location past its grace period, keeping its codes as retired ones', async () => {
    const a = await seedTenant(db, 'a');
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const box = await thing(flat, { name: 'Box' });
    await thing(flat, { name: 'Inner', containerId: box });
    const code = randomShortCode();
    await own('INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)', [
      code,
      flat.locationId,
      box,
    ]);
    const photo = await file(flat, a.userId);
    await own(
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by) VALUES ($1, $2, $3, 'photo', $4)`,
      [flat.locationId, photo, box, a.userId],
    );
    // A copy of the photo elsewhere shares its blob (D161), so that key must survive.
    const shared = await file(a, a.userId, { key: `f/${flat.locationId}/${photo}` });
    await own(
      `UPDATE public.locations SET deleted_at = now() - interval '31 days', purge_after = now() - interval '1 day' WHERE id = $1`,
      [flat.locationId],
    );
    const rows = await sys<{ location_id: string; storage_keys: string[] }>(
      'SELECT * FROM kept.purge_deleted_locations(10)',
    );
    expect(rows).toEqual([
      { location_id: flat.locationId, storage_keys: [`d/${photo}/thumb.jpg`] },
    ]);
    expect(await own('SELECT id FROM public.locations WHERE id = $1', [flat.locationId])).toEqual(
      [],
    );
    expect(
      await own('SELECT state, location_id FROM public.short_ids WHERE code = $1', [code]),
    ).toEqual([{ state: 'retired', location_id: flat.locationId }]);
    expect(await own('SELECT id FROM public.files WHERE id = $1', [shared])).toHaveLength(1);
  });
});

describe('kept.purge_orphan_files() (D161, D162)', () => {
  it('purges old unattached files and returns only the blobs nothing else references', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const orphan = await file(a, a.userId);
    const recent = await file(a, a.userId, { age: '1 hour' });
    const attached = await file(a, a.userId);
    await own(
      `INSERT INTO public.attachments (location_id, file_id, role, created_by) VALUES ($1, $2, 'document', $3)`,
      [a.locationId, attached, a.userId],
    );
    // An unattached file whose blob a copy in B still holds (D161).
    const sharedKey = `f/${a.locationId}/${newId()}`;
    const shared = await file(a, a.userId, { key: sharedKey });
    const copy = await file(b, b.userId, { key: sharedKey, age: '1 hour' });
    const keys = await sys<{ storage_key: string }>(
      `SELECT storage_key FROM kept.purge_orphan_files(now() - interval '24 hours', 100)`,
    );
    expect(keys.map((k) => k.storage_key).sort()).toEqual(
      [`f/${a.locationId}/${orphan}`, `d/${orphan}/thumb.jpg`, `d/${shared}/thumb.jpg`].sort(),
    );
    const left = await own<{ id: string }>('SELECT id FROM public.files WHERE id = ANY ($1)', [
      [orphan, recent, attached, shared, copy],
    ]);
    expect(left.map((r) => r.id).sort()).toEqual([recent, attached, copy].sort());
  });
});

describe('kept.unreferenced_storage_keys() (D161, D162)', () => {
  it('answers only the keys no file or derivative row names any more', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const kept = await file(a, a.userId);
    // A copy in B holds the key of a file A no longer has (D161).
    const sharedKey = `f/${a.locationId}/${newId()}`;
    await file(b, b.userId, { key: sharedKey });
    const gone = `f/${a.locationId}/${newId()}`;
    const keys = await sys<{ key: string }>(
      'SELECT k AS key FROM kept.unreferenced_storage_keys($1) AS k',
      [[`f/${a.locationId}/${kept}`, `d/${kept}/thumb.jpg`, sharedKey, gone, gone, null]],
    );
    expect(keys).toEqual([{ key: gone }]);
    expect(await sys('SELECT * FROM kept.unreferenced_storage_keys($1)', [[]])).toEqual([]);
  });
});

describe('who may open these doors', () => {
  it('refuses kept_app every one of them (42501)', async () => {
    const a = await seedTenant(db, 'a');
    for (const sql of [
      'SELECT kept.reindex_location($1)',
      `SELECT kept.purge_trash(now(), 1)`,
      'SELECT kept.purge_deleted_locations(1)',
      `SELECT kept.purge_orphan_files(now(), 1)`,
      `SELECT * FROM kept.unreferenced_storage_keys('{}')`,
    ]) {
      const call = withScope(db.pools.app, { userId: a.userId, mfa: true }, (_tx, c) =>
        c.query(sql, sql.includes('$1') ? [a.locationId] : []),
      );
      expect((await pgError(call)).code, sql).toBe('42501');
    }
  });
});
