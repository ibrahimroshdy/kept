import { newId } from '@kept/shared';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx, pgError, seedTenant, type Tenant } from '../../test/tenancy.js';
import { withScope } from './scope.js';

// Step-3 T4, plan Q1 (engineering spec §7.4): the snapshot's watermark. A cursor on change_seq
// alone skips a transaction that took its sequence value early and committed late; a cursor on
// change_xid from pg_snapshot_xmin never does. Two raw kept_app connections hold transactions
// open while a third reads, as the snapshot route would.

const db = await testDb();

let t: Tenant;
let thingA: string;
let thingB: string;
const open: pg.Client[] = [];

/** A kept_app connection with an open, scoped transaction. */
async function begin(userId: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: db.urls.app });
  c.on('error', () => {});
  await c.connect();
  open.push(c);
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.mfa', 'true', true)", [
    userId,
  ]);
  return c;
}

/**
 * One pass of the snapshot: the rows changed at or after `since` (as `id=name/notes`), and the
 * next watermark. The horizon is the whole server's oldest running transaction, so under a
 * parallel test run a pass may repeat rows it has already given: duplicates are harmless, and the
 * assertions only ask what must, or must not yet, be there.
 */
async function pass(since: string | null): Promise<{ rows: string[]; next: string }> {
  return withScope(db.pools.app, { userId: t.userId, mfa: true }, async (_tx, c) => {
    const { rows } = await c.query<{ r: string }>(
      `SELECT id || '=' || name || '/' || coalesce(notes, '') AS r FROM public.things
        WHERE location_id = $1 AND ($2::xid8 IS NULL OR change_xid >= $2::xid8)
        ORDER BY id`,
      [t.locationId, since],
    );
    const next = await c.query<{ x: string }>(
      'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS x',
    );
    return { rows: rows.map((r) => r.r), next: next.rows[0]?.x as string };
  });
}

beforeEach(async () => {
  await db.reset();
  t = await seedTenant(db, 'watermark');
  thingA = newId();
  thingB = newId();
  await ownerTx(db, async (c) => {
    for (const [id, name] of [
      [thingA, 'Drill'],
      [thingB, 'Ladder'],
    ]) {
      await c.query(
        'INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, $4)',
        [id, t.locationId, t.unplacedId, name],
      );
    }
  });
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.end().catch(() => {});
});

describe('the change_xid watermark (Q1)', () => {
  it('re-reads a change whose transaction committed after a younger one was seen', async () => {
    const first = await pass(null);
    expect(first.rows.sort()).toEqual([`${thingA}=Drill/`, `${thingB}=Ladder/`].sort());

    const t1 = await begin(t.userId);
    await t1.query(`UPDATE public.things SET name = 'Drill, cordless' WHERE id = $1`, [thingA]);
    const t2 = await begin(t.userId);
    await t2.query(`UPDATE public.things SET name = 'Ladder, tall' WHERE id = $1`, [thingB]);
    await t2.query('COMMIT');
    const seqs = await ownerTx(db, async (c) => {
      const { rows } = await c.query<{ id: string; change_seq: string }>(
        'SELECT id, change_seq FROM public.things WHERE id = ANY ($1)',
        [[thingA, thingB]],
      );
      return Object.fromEntries(rows.map((r) => [r.id, BigInt(r.change_seq)]));
    });
    // T1 took the smaller sequence value but has not committed: a seq cursor would move past it.
    expect(seqs[thingA] as bigint).toBeLessThan(seqs[thingB] as bigint);

    const second = await pass(first.next);
    expect(second.rows).toContain(`${thingB}=Ladder, tall/`);
    expect(second.rows).not.toContain(`${thingA}=Drill, cordless/`);

    await t1.query('COMMIT');
    const third = await pass(second.next);
    expect(third.rows).toContain(`${thingA}=Drill, cordless/`);
  });

  it('never skips an older transaction that takes its sequence after a younger one commits', async () => {
    const first = await pass(null);
    const old = await begin(t.userId);
    // The older transaction has its id before the younger one starts.
    await old.query('SELECT pg_current_xact_id()');
    const young = await begin(t.userId);
    await young.query(`UPDATE public.things SET notes = 'young' WHERE id = $1`, [thingB]);
    await young.query('COMMIT');

    const second = await pass(first.next);
    expect(second.rows).toContain(`${thingB}=Ladder/young`);

    await old.query(`UPDATE public.things SET notes = 'old' WHERE id = $1`, [thingA]);
    await old.query('COMMIT');
    const third = await pass(second.next);
    expect(third.rows).toContain(`${thingA}=Drill/old`);
  });

  it('stamps nothing on a quiet update (search_tsv only)', async () => {
    const read = () =>
      ownerTx(db, async (c) => {
        const { rows } = await c.query<{ change_xid: string; change_seq: string }>(
          'SELECT change_xid::text, change_seq FROM public.things WHERE id = $1',
          [thingA],
        );
        return rows[0];
      });
    const before = await read();
    await ownerTx(db, (c) =>
      c.query('UPDATE public.things SET search_tsv = NULL WHERE id = $1', [thingA]),
    );
    expect(await read()).toEqual(before);
    // A real edit stamps a new one.
    await ownerTx(db, (c) =>
      c.query(`UPDATE public.things SET notes = 'moved' WHERE id = $1`, [thingA]),
    );
    const after = await read();
    expect(BigInt(after?.change_xid as string)).toBeGreaterThan(
      BigInt(before?.change_xid as string),
    );
  });

  it('stamps every synced table on insert and update', async () => {
    const rows = await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.legacy_codes (location_id, source, code, thing_id)
         VALUES ($1, 'csv', 'OLD-7', $2)`,
        [t.locationId, thingA],
      );
      await c.query(
        `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
         VALUES ($1, 'place', $2)`,
        [t.locationId, newId()],
      );
      const { rows } = await c.query<{ t: string; n: number }>(
        `SELECT t, count(*)::int AS n FROM (
           SELECT 'places' AS t, change_xid FROM public.places WHERE location_id = $1
           UNION ALL SELECT 'things', change_xid FROM public.things WHERE location_id = $1
           UNION ALL SELECT 'legacy_codes', change_xid FROM public.legacy_codes WHERE location_id = $1
           UNION ALL SELECT 'sync_tombstones', change_xid FROM public.sync_tombstones
                      WHERE location_id = $1) x
          WHERE change_xid IS NULL GROUP BY t`,
        [t.locationId],
      );
      return rows;
    });
    expect(rows).toEqual([]);
  });

  it('refuses kept_app writing change_xid itself (no column grant)', async () => {
    const err = await pgError(
      withScope(db.pools.app, { userId: t.userId, mfa: true }, (_tx, c) =>
        c.query(`UPDATE public.things SET change_xid = '1'::xid8 WHERE id = $1`, [thingA]),
      ),
    );
    expect(err.code).toBe('42501');
  });
});
