import { createHash } from 'node:crypto';
import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
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
import { withScope } from './scope.js';

// Step-3 T7: kept.merge_things(), a duplicate merged into its survivor, keeping both histories
// (D36; plan Q16).

const db = await testDb();

let t: Tenant;
let alfred: string;
let bruce: string;
let dup: string;
let keep: string;
let dupCode: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const merge = (userId: string, from: string, into: string) =>
  as(
    userId,
    async (c) =>
      (await c.query('SELECT kept.merge_things($1, $2) AS n', [from, into])).rows[0].n as number,
  );

beforeEach(async () => {
  await db.reset();
  t = await seedTenant(db, 'merge-ibrahim');
  alfred = await seedUser(db, 'merge-alfred');
  await addMember(db, t.locationId, alfred, 'member');
  bruce = await seedUser(db, 'merge-bruce');
  await addMember(db, t.locationId, bruce, 'viewer');
  dup = newId();
  keep = newId();
  dupCode = randomShortCode();
  await ownerTx(db, async (c) => {
    await c.query(
      `INSERT INTO public.things (id, location_id, place_id, name)
       VALUES ($1, $3, $4, 'Drill (2)'), ($2, $3, $4, 'Drill')`,
      [dup, keep, t.locationId, t.unplacedId],
    );
    await c.query(
      `INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)`,
      [dupCode, t.locationId, dup],
    );
    await c.query(
      `INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)`,
      [randomShortCode(), t.locationId, keep],
    );
    // A bit inside the duplicate, a photo of it, a tag, a link and an old Homebox code.
    await c.query(
      `INSERT INTO public.things (location_id, container_id, name) VALUES ($1, $2, 'Drill bit')`,
      [t.locationId, dup],
    );
    const file = newId();
    await c.query(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
      [
        file,
        t.locationId,
        `f/${t.locationId}/${file}`,
        createHash('sha256').update(file).digest('hex'),
        t.userId,
      ],
    );
    await c.query(
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
       VALUES ($1, $2, $3, 'photo', $4)`,
      [t.locationId, file, dup, t.userId],
    );
    const tag = newId();
    await c.query(`INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, 'Tools')`, [
      tag,
      t.accountId,
    ]);
    await c.query(
      `INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
      [t.locationId, dup, tag, keep],
    );
    await c.query(
      `INSERT INTO public.thing_links (location_id, from_thing_id, to_thing_id, kind)
       VALUES ($1, $2, $3, 'related')`,
      [t.locationId, dup, keep],
    );
    await c.query(
      `INSERT INTO public.legacy_codes (location_id, source, code, thing_id)
       VALUES ($1, 'homebox', 'HB-000042', $2)`,
      [t.locationId, dup],
    );
  });
});

describe('kept.merge_things (D36, Q16)', () => {
  it('moves what the duplicate had to the survivor, and trashes it with merged_into_id', async () => {
    const n = await merge(alfred, dup, keep);
    expect(n).toBeGreaterThanOrEqual(5);
    expect(
      await own(
        'SELECT deleted_at IS NOT NULL AS trashed, merged_into_id FROM public.things WHERE id = $1',
        [dup],
      ),
    ).toEqual([{ trashed: true, merged_into_id: keep }]);
    expect(await own(`SELECT container_id FROM public.things WHERE name = 'Drill bit'`)).toEqual([
      { container_id: keep },
    ]);
    expect(await own('SELECT thing_id FROM public.attachments')).toEqual([{ thing_id: keep }]);
    expect(await own('SELECT thing_id FROM public.thing_tags')).toEqual([{ thing_id: keep }]);
    // The link between the two goes (it would be a link to itself).
    expect(await own('SELECT 1 FROM public.thing_links')).toEqual([]);
    expect(await own('SELECT thing_id FROM public.legacy_codes')).toEqual([{ thing_id: keep }]);
    // The photo is the survivor's cover now.
    expect(
      (
        await own<{ c: string | null }>(
          'SELECT cover_file_id AS c FROM public.things WHERE id = $1',
          [keep],
        )
      )[0]?.c,
    ).not.toBeNull();
  });

  it('keeps an old label of the duplicate finding the survivor, as a secondary code', async () => {
    await merge(alfred, dup, keep);
    expect(
      await own('SELECT thing_id, is_primary, state FROM public.short_ids WHERE code = $1', [
        dupCode,
      ]),
    ).toEqual([{ thing_id: keep, is_primary: false, state: 'assigned' }]);
    // The survivor's own code stays its primary one.
    expect(
      await own(
        `SELECT count(*)::int AS n FROM public.short_ids WHERE thing_id = $1 AND is_primary`,
        [keep],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('refuses both metered, a survivor inside the duplicate, a viewer and another location (42501)', async () => {
    await own(
      `INSERT INTO public.meters (location_id, thing_id, kind, unit)
       VALUES ($1, $2, 'hours', 'h'), ($1, $3, 'hours', 'h')`,
      [t.locationId, dup, keep],
    );
    expect(await pgError(merge(alfred, dup, keep))).toMatchObject({
      code: '23514',
      constraint: 'things_merge_meters',
    });
    await own('DELETE FROM public.meters');
    const bit = (
      await own<{ id: string }>(`SELECT id FROM public.things WHERE name = 'Drill bit'`)
    )[0]?.id as string;
    expect(await pgError(merge(alfred, dup, bit))).toMatchObject({ constraint: 'things_no_loop' });
    expect((await pgError(merge(bruce, dup, keep))).code).toBe('42501');
    const cottage = await ownerTx(db, (c) =>
      insertLocation(c, { userId: t.userId, accountId: t.accountId }, { name: 'Cottage' }),
    );
    const away = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
      [away, cottage.locationId, cottage.unplacedId],
    );
    expect((await pgError(merge(t.userId, dup, away))).code).toBe('42501');
    const talia = await seedTenant(db, 'merge-talia');
    expect((await pgError(merge(talia.userId, dup, keep))).code).toBe('42501');
    expect((await pgError(merge(alfred, dup, dup))).code).toBe('42501');
  });
});
