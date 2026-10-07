import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
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

// Step-3 T4: the sync ledger, legacy codes, box checks, the cover cache and tombstones on
// arrival (engineering spec §1.10, §2.3, §7.4, §7.13; D40, D146, D156, D175, D195).

const db = await testDb();

let t: Tenant;
let member: string;
let viewer: string;
let box: string;
let inside: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

const opRow = (userId: string, key: string, locationId: string | null) => [
  userId,
  key,
  newId(),
  locationId,
  createHash('sha256').update(key).digest('hex'),
];
const INSERT_OP = `INSERT INTO public.sync_ops (user_id, idempotency_key, client_id, location_id, op,
                     payload_version, client_version, taken_at, request_hash, outcome)
                   VALUES ($1, $2, $3, $4, 'mark_seen', 1, '0.3.0', now(), $5, 'applied')`;

beforeEach(async () => {
  await db.reset();
  t = await seedTenant(db, 'sync-ibrahim');
  member = await seedUser(db, 'sync-alfred');
  await addMember(db, t.locationId, member, 'member');
  viewer = await seedUser(db, 'sync-bruce');
  await addMember(db, t.locationId, viewer, 'viewer');
  box = newId();
  inside = newId();
  await ownerTx(db, async (c) => {
    await c.query(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Box 3')`,
      [box, t.locationId, t.unplacedId],
    );
    await c.query(
      `INSERT INTO public.things (id, location_id, container_id, name, quantity)
       VALUES ($1, $2, $3, 'Screws', 3)`,
      [inside, t.locationId, box],
    );
  });
});

describe('sync_ops', () => {
  it("is a person's own ledger, even within one location", async () => {
    await as(member, (c) => c.query(INSERT_OP, opRow(member, 'op-000001', t.locationId)));
    expect((await as(member, (c) => c.query('SELECT 1 FROM public.sync_ops'))).rowCount).toBe(1);
    expect((await as(t.userId, (c) => c.query('SELECT 1 FROM public.sync_ops'))).rowCount).toBe(0);
    // Written as someone else: refused.
    expect(
      (await pgError(as(t.userId, (c) => c.query(INSERT_OP, opRow(member, 'op-000002', null)))))
        .code,
    ).toBe('42501');
  });

  it('is append-only, and a replay of the same key is a conflict', async () => {
    await as(member, (c) => c.query(INSERT_OP, opRow(member, 'op-000003', t.locationId)));
    expect(
      (await pgError(as(member, (c) => c.query(`UPDATE public.sync_ops SET outcome = 'dropped'`))))
        .code,
    ).toBe('42501');
    expect((await pgError(as(member, (c) => c.query('DELETE FROM public.sync_ops')))).code).toBe(
      '42501',
    );
    expect(
      (await pgError(as(member, (c) => c.query(INSERT_OP, opRow(member, 'op-000003', null))))).code,
    ).toBe('23505');
  });

  it('refuses a location the person can’t see', async () => {
    const other = await seedTenant(db, 'sync-talia');
    expect(
      (
        await pgError(
          as(member, (c) => c.query(INSERT_OP, opRow(member, 'op-000004', other.locationId))),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('legacy_codes', () => {
  const insertCode = (userId: string, code: string, thing: string) =>
    as(userId, (c) =>
      c.query(
        `INSERT INTO public.legacy_codes (location_id, source, code, thing_id)
         VALUES ($1, 'csv', $2, $3)`,
        [t.locationId, code, thing],
      ),
    );

  it('are written by members, read by viewers, and stored normalised', async () => {
    await insertCode(member, 'HB-0042', box);
    expect((await as(viewer, (c) => c.query('SELECT code FROM public.legacy_codes'))).rows).toEqual(
      [{ code: 'HB-0042' }],
    );
    expect((await pgError(insertCode(viewer, 'HB-0043', box))).code).toBe('42501');
    expect((await pgError(insertCode(member, ' hb-0044', box))).constraint).toBe(
      'legacy_codes_code_chk',
    );
  });

  it('follow a container that becomes a place', async () => {
    await insertCode(member, 'HB-0050', box);
    await as(member, (c) => c.query('SELECT kept.convert_container_to_place($1, NULL)', [box]));
    expect(await own('SELECT thing_id, place_id FROM public.legacy_codes')).toEqual([
      { thing_id: null, place_id: box },
    ]);
  });

  it('move only their target', async () => {
    await insertCode(member, 'HB-0051', box);
    await as(member, (c) => c.query('UPDATE public.legacy_codes SET thing_id = $1', [inside]));
    expect(
      (await pgError(as(member, (c) => c.query(`UPDATE public.legacy_codes SET code = 'X'`)))).code,
    ).toBe('42501');
  });
});

describe('box checks', () => {
  it('are recorded by writers as themselves, and never changed', async () => {
    const check = newId();
    await as(member, async (c) => {
      await c.query(
        `INSERT INTO public.box_checks (id, location_id, container_id, checked_by, checked_at)
         VALUES ($1, $2, $3, $4, now())`,
        [check, t.locationId, box, member],
      );
      await c.query(
        `INSERT INTO public.box_check_lines (box_check_id, location_id, thing_id, expected_qty,
                                             found_qty)
         VALUES ($1, $2, $3, 3, 2)`,
        [check, t.locationId, inside],
      );
    });
    const asSomeoneElse = await pgError(
      as(member, (c) =>
        c.query(
          `INSERT INTO public.box_checks (location_id, container_id, checked_by, checked_at)
           VALUES ($1, $2, $3, now())`,
          [t.locationId, box, t.userId],
        ),
      ),
    );
    expect(asSomeoneElse.code).toBe('42501');
    expect(
      (
        await pgError(
          as(viewer, (c) =>
            c.query(
              `INSERT INTO public.box_checks (location_id, container_id, checked_by, checked_at)
               VALUES ($1, $2, $3, now())`,
              [t.locationId, box, viewer],
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    for (const sql of [
      'UPDATE public.box_check_lines SET found_qty = 3',
      'DELETE FROM public.box_check_lines',
      'DELETE FROM public.box_checks',
    ]) {
      expect((await pgError(as(member, (c) => c.query(sql)))).code, sql).toBe('42501');
    }
    expect(
      (await as(viewer, (c) => c.query('SELECT found_qty FROM public.box_check_lines'))).rows,
    ).toEqual([{ found_qty: '2.000' }]);
  });
});

describe('the cover cache (D195)', () => {
  async function photo(sort: number): Promise<{ file: string; attachment: string }> {
    const file = newId();
    const attachment = newId();
    await ownerTx(db, async (c) => {
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
        `INSERT INTO public.attachments (id, location_id, file_id, thing_id, role, sort, created_by)
         VALUES ($1, $2, $3, $4, 'photo', $5, $6)`,
        [attachment, t.locationId, file, box, sort, t.userId],
      );
    });
    return { file, attachment };
  }
  const read = async () =>
    (
      await own<{ cover_file_id: string | null; row_version: number; change_seq: string }>(
        'SELECT cover_file_id, row_version, change_seq FROM public.things WHERE id = $1',
        [box],
      )
    )[0];

  it('follows the first photo, bumping change_seq but never row_version', async () => {
    const before = await read();
    const second = await photo(2);
    const first = await photo(1);
    const after = await read();
    expect(after?.cover_file_id).toBe(first.file);
    expect(after?.row_version).toBe(before?.row_version);
    expect(BigInt(after?.change_seq as string)).toBeGreaterThan(
      BigInt(before?.change_seq as string),
    );
    await own('DELETE FROM public.attachments WHERE id = $1', [first.attachment]);
    expect((await read())?.cover_file_id).toBe(second.file);
    await own(`UPDATE public.attachments SET role = 'manual' WHERE id = $1`, [second.attachment]);
    expect((await read())?.cover_file_id).toBeNull();
  });

  it('follows its photo across a move to another location', async () => {
    await photo(1);
    const second = await ownerTx(db, (c) =>
      insertLocation(c, { userId: t.userId, accountId: t.accountId }, { name: 'Cottage' }),
    );
    await as(t.userId, (c) =>
      c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
        [box],
        second.locationId,
        second.unplacedId,
      ]),
    );
    const rows = await own<{ ok: boolean }>(
      `SELECT f.location_id = t.location_id AS ok FROM public.things t
         JOIN public.files f ON f.id = t.cover_file_id WHERE t.id = $1`,
      [box],
    );
    expect(rows).toEqual([{ ok: true }]);
  });
});

describe('tombstones on arrival (§7.4, D156)', () => {
  it('a thing moved A → B → A → B leaves exactly one tombstone, where it last left', async () => {
    const b = await ownerTx(db, (c) =>
      insertLocation(c, { userId: t.userId, accountId: t.accountId }, { name: 'Cottage' }),
    );
    const move = (to: { locationId: string; unplacedId: string }) =>
      as(t.userId, (c) =>
        c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
          [box],
          to.locationId,
          to.unplacedId,
        ]),
      );
    const tombs = () =>
      own<{ location_id: string }>(
        `SELECT location_id FROM public.sync_tombstones
          WHERE entity_type = 'thing' AND entity_id = $1`,
        [box],
      );
    await move(b);
    await move(t);
    expect(await tombs()).toEqual([{ location_id: b.locationId }]);
    await move(b);
    expect(await tombs()).toEqual([{ location_id: t.locationId }]);
  });

  it('a thing arriving under an id its location had tombstoned clears the tombstone', async () => {
    const id = newId();
    await own(
      `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
       VALUES ($1, 'thing', $2)`,
      [t.locationId, id],
    );
    await as(member, (c) =>
      c.query(
        `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Kettle')`,
        [id, t.locationId, t.unplacedId],
      ),
    );
    expect(await own('SELECT 1 FROM public.sync_tombstones WHERE entity_id = $1', [id])).toEqual(
      [],
    );
  });
});
