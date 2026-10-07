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

// Step-3 T7: label batches, the blank-label cap and claiming a blank label (D43, D44, D112,
// D137, D172; engineering spec §2.4, §3.1b; plan Q24).

const db = await testDb();

let t: Tenant;
let cottage: { locationId: string; unplacedId: string };
let alfred: string;
let bruce: string;
let talia: Tenant;
let drill: string;
let kettle: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

beforeEach(async () => {
  await db.reset();
  t = await seedTenant(db, 'labels-ibrahim');
  cottage = await ownerTx(db, (c) =>
    insertLocation(c, { userId: t.userId, accountId: t.accountId }, { name: 'Cottage' }),
  );
  alfred = await seedUser(db, 'labels-alfred');
  await addMember(db, t.locationId, alfred, 'member');
  bruce = await seedUser(db, 'labels-bruce');
  await addMember(db, t.locationId, bruce, 'viewer');
  talia = await seedTenant(db, 'labels-talia');
  drill = newId();
  kettle = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name)
     VALUES ($1, $2, $3, 'Drill'), ($4, $5, $6, 'Kettle')`,
    [drill, t.locationId, t.unplacedId, kettle, cottage.locationId, cottage.unplacedId],
  );
});

const blank = async (locationId: string) => {
  const code = randomShortCode();
  await own(
    `INSERT INTO public.short_ids (code, location_id, state, is_primary)
     VALUES ($1, $2, 'blank', false)`,
    [code, locationId],
  );
  return code;
};
const claim = (userId: string, code: string, thing: string | null, place: string | null = null) =>
  as(
    userId,
    async (c) =>
      (await c.query('SELECT * FROM kept.claim_blank_code($1, $2, $3)', [code, thing, place]))
        .rows[0],
  );

describe('claiming a blank label (D43, D112)', () => {
  it('claims it for a thing of its location, as the primary code when the thing has none', async () => {
    const code = await blank(t.locationId);
    expect(await claim(alfred, code, drill)).toEqual({
      outcome: 'claimed',
      thing_id: drill,
      place_id: null,
      name: 'Drill',
    });
    expect(
      await own(
        'SELECT state, thing_id, is_primary, claimed_by FROM public.short_ids WHERE code = $1',
        [code],
      ),
    ).toEqual([{ state: 'assigned', thing_id: drill, is_primary: true, claimed_by: alfred }]);
    // The second claim of the same label learns who has it.
    const other = newId();
    await own(
      `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Ladder')`,
      [other, t.locationId, t.unplacedId],
    );
    expect(await claim(t.userId, code, other)).toMatchObject({
      outcome: 'already_claimed',
      thing_id: drill,
      name: 'Drill',
    });
  });

  it('claims one for a place, secondary when the place already has a code', async () => {
    const code = await blank(t.locationId);
    await own(`INSERT INTO public.short_ids (code, location_id, place_id) VALUES ($1, $2, $3)`, [
      randomShortCode(),
      t.locationId,
      t.unplacedId,
    ]);
    expect(await claim(alfred, code, null, t.unplacedId)).toMatchObject({ outcome: 'claimed' });
    expect(await own('SELECT is_primary FROM public.short_ids WHERE code = $1', [code])).toEqual([
      { is_primary: false },
    ]);
  });

  it('answers a missing, retired, other-location or invisible code, and a viewer, alike (42501)', async () => {
    const elsewhere = await blank(cottage.locationId);
    const theirs = await blank(talia.locationId);
    const retired = randomShortCode();
    await own(
      `INSERT INTO public.short_ids (code, location_id, state, is_primary)
       VALUES ($1, $2, 'retired', false)`,
      [retired, t.locationId],
    );
    const mine = await blank(t.locationId);
    const codes: Record<string, string> = {};
    for (const [label, p] of [
      ['missing', () => claim(alfred, randomShortCode(), drill)],
      ['retired', () => claim(alfred, retired, drill)],
      ['another location', () => claim(t.userId, elsewhere, drill)],
      ['another household', () => claim(alfred, theirs, drill)],
      ['a viewer', () => claim(bruce, mine, drill)],
      ['a thing of another household', () => claim(talia.userId, theirs, drill)],
      ['both targets', () => claim(alfred, mine, drill, t.unplacedId)],
    ] as const) {
      codes[label] = (await pgError(p())).code;
    }
    expect(new Set(Object.values(codes))).toEqual(new Set(['42501']));
    // Nothing changed.
    expect(
      await own(`SELECT count(*)::int AS n FROM public.short_ids WHERE state = 'blank'`),
    ).toEqual([{ n: 3 }]);
  });
});

describe('the blank-label cap (§3.1b)', () => {
  it('refuses the 1,001st unclaimed blank label of a location', async () => {
    // 1,000 distinct codes (hex digits are Crockford characters too).
    await own(
      `INSERT INTO public.short_ids (code, location_id, state, is_primary)
       SELECT DISTINCT upper(substr(md5('blank-' || g), 1, 6)), $1::uuid, 'blank', false
         FROM generate_series(1, 1000) g`,
      [t.locationId],
    );
    const [{ n }] = (await own<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.short_ids WHERE location_id = $1 AND state = 'blank'`,
      [t.locationId],
    )) as [{ n: number }];
    for (let i = n; i < 1000; i++) await blank(t.locationId);
    const err = await pgError(blank(t.locationId));
    expect(err).toMatchObject({ code: '23514', constraint: 'short_ids_blank_cap' });
    // Another location has its own allowance.
    await blank(cottage.locationId);
  });
});

describe('label batches', () => {
  it('are made by writers with their own location’s codes, and only "Printed OK?" changes', async () => {
    const code = randomShortCode();
    await own(`INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)`, [
      code,
      t.locationId,
      drill,
    ]);
    const theirs = randomShortCode();
    await own(
      `INSERT INTO public.short_ids (code, location_id, state, is_primary)
               VALUES ($1, $2, 'blank', false)`,
      [theirs, talia.locationId],
    );
    const batch = newId();
    const make = (userId: string) =>
      as(userId, (c) =>
        c.query(
          `INSERT INTO public.label_batches (id, location_id, kind, stock, code_count, created_by)
           VALUES ($1, $2, 'things', 'thermal_50x30', 1, $3)`,
          [newId(), t.locationId, userId],
        ),
      );
    expect((await pgError(make(bruce))).code).toBe('42501');
    await as(alfred, async (c) => {
      await c.query(
        `INSERT INTO public.label_batches (id, location_id, kind, stock, code_count, created_by)
         VALUES ($1, $2, 'things', 'thermal_50x30', 1, $3)`,
        [batch, t.locationId, alfred],
      );
      await c.query(
        `INSERT INTO public.label_batch_codes (batch_id, location_id, code, sort) VALUES ($1, $2, $3, 1)`,
        [batch, t.locationId, code],
      );
      await c.query('UPDATE public.label_batches SET printed_confirmed_at = now() WHERE id = $1', [
        batch,
      ]);
    });
    // Another household's code: refused by the policy, not revealed by the foreign key.
    const probe = await pgError(
      as(alfred, (c) =>
        c.query(
          `INSERT INTO public.label_batch_codes (batch_id, location_id, code, sort) VALUES ($1, $2, $3, 2)`,
          [batch, t.locationId, theirs],
        ),
      ),
    );
    expect(probe.code).toBe('42501');
    for (const sql of [
      `UPDATE public.label_batches SET stock = 'a4_24_70x37'`,
      'DELETE FROM public.label_batch_codes',
      'DELETE FROM public.label_batches',
    ]) {
      expect((await pgError(as(alfred, (c) => c.query(sql)))).code, sql).toBe('42501');
    }
  });
});
