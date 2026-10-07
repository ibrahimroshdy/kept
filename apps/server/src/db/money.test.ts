import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope, withSystem } from './scope.js';

// Step-4 T4 (0048, 0049): exchange rates, valuations, incidents and export runs under row-level
// security, and the claim-pack doors (engineering spec §1.4, §1.10, §7.1; D158, D180; plan Q19).
// The AI money caps through exchange rates are in src/db/ai.test.ts.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owner of Home
let bruce: string; // admin
let louis: string; // member
let talia: string; // viewer
let alfred: Tenant; // another household
let tv: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const count = (userId: string, sql: string, values: unknown[] = []) =>
  as(userId, async (c) => (await c.query(sql, values)).rowCount ?? 0);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'money-ibrahim');
  bruce = await seedUser(db, 'money-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'money-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  talia = await seedUser(db, 'money-talia');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  alfred = await seedTenant(db, 'money-alfred');
  tv = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'TV')`,
    [tv, ibrahim.locationId, ibrahim.unplacedId],
  );
});

describe('exchange rates (D136)', () => {
  const addRate = (userId: string, validFrom = '2026-09-01') =>
    as(userId, (c) =>
      c.query(
        `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from, created_by)
         VALUES ($1, 'USD', 'EGP', 48.5, $2, $3)`,
        [ibrahim.accountId, validFrom, userId],
      ),
    );

  it("are the account's: its admins write them, its members and viewers only read", async () => {
    await addRate(bruce);
    expect((await pgError(addRate(louis, '2026-09-02'))).code).toBe('42501');
    expect((await pgError(addRate(talia, '2026-09-03'))).code).toBe('42501');
    const read = 'SELECT 1 FROM public.fx_rates WHERE owner_account_id = $1';
    expect(await count(talia, read, [ibrahim.accountId])).toBe(1);
    expect(await count(alfred.userId, read, [ibrahim.accountId])).toBe(0);
    expect(
      await count(louis, `UPDATE public.fx_rates SET rate = 50 WHERE owner_account_id = $1`, [
        ibrahim.accountId,
      ]),
    ).toBe(0);
    expect(
      await count(bruce, `UPDATE public.fx_rates SET rate = 50 WHERE owner_account_id = $1`, [
        ibrahim.accountId,
      ]),
    ).toBe(1);
  });

  it('refuse a pair of one currency, a rate of zero, and a currency Kept lacks', async () => {
    const bad = (from: string, to: string, rate: number) =>
      pgError(
        own(
          `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from,
                                        created_by)
           VALUES ($1, $2, $3, $4, '2026-09-01', $5)`,
          [ibrahim.accountId, from, to, rate, ibrahim.userId],
        ),
      );
    expect((await bad('EGP', 'EGP', 1)).constraint).toBe('fx_rates_pair_chk');
    expect((await bad('USD', 'EGP', 0)).constraint).toBe('fx_rates_rate_chk');
    expect((await bad('USD', 'XYZ', 1)).code).toBe('23503');
  });

  it("kept.fx_rate: the pair's newest on or before the day, else its inverse's, never chained", async () => {
    await own(
      `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from, created_by)
       VALUES ($1, 'USD', 'EGP', 48, '2026-09-01', $2), ($1, 'USD', 'EGP', 49, '2026-09-12', $2),
              ($1, 'EGP', 'USD', 0.02, '2026-09-10', $2), ($1, 'EUR', 'USD', 1.1, '2026-09-01', $2)`,
      [ibrahim.accountId, ibrahim.userId],
    );
    const rate = async (from: string, to: string, on: string, account = ibrahim.accountId) =>
      (
        await own<{ r: string | null }>('SELECT kept.fx_rate($1, $2, $3, $4)::text AS r', [
          account,
          from,
          to,
          on,
        ])
      )[0]?.r ?? null;
    expect(await rate('USD', 'EGP', '2026-09-05')).toBe('48.00000000');
    // The pair wins over a newer inverse (@kept/shared money.ts convert's order).
    expect(await rate('USD', 'EGP', '2026-09-11')).toBe('48.00000000');
    expect(await rate('USD', 'EGP', '2026-09-12')).toBe('49.00000000');
    // No EGP → USD before 09-10: the inverse of USD → EGP, 1/48.
    expect(Number(await rate('EGP', 'USD', '2026-09-05'))).toBeCloseTo(1 / 48, 12);
    expect(await rate('EGP', 'USD', '2026-09-10')).toBe('0.02000000');
    expect(await rate('USD', 'EGP', '2026-08-31')).toBeNull();
    // EUR → EGP would need USD in the middle: none.
    expect(await rate('EUR', 'EGP', '2026-09-15')).toBeNull();
    expect(await rate('EGP', 'EGP', '2020-01-01')).toBe('1');
    // Another account's rates count for nothing here.
    expect(await rate('USD', 'EGP', '2026-09-05', alfred.accountId)).toBeNull();
  });
});

describe('valuations (D158)', () => {
  const addValuation = (userId: string, thingId = tv) =>
    as(userId, (c) =>
      c.query(
        `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                        created_by)
         VALUES ($1, $2, 9000, 'EGP', '2026-09-20', 'appraisal', $3)`,
        [ibrahim.locationId, thingId, userId],
      ),
    );

  it("are written by the thing's writers, read by its viewers, invisible elsewhere", async () => {
    await addValuation(louis);
    expect((await pgError(addValuation(talia))).code).toBe('42501');
    const read = 'SELECT 1 FROM public.valuations WHERE thing_id = $1';
    expect(await count(talia, read, [tv])).toBe(1);
    expect(await count(alfred.userId, read, [tv])).toBe(0);
    expect(
      await count(louis, `UPDATE public.valuations SET value = 1 WHERE thing_id = $1`, [tv]),
    ).toBe(1);
    expect(
      (
        await pgError(
          as(louis, (c) =>
            c.query(`UPDATE public.valuations SET thing_id = thing_id WHERE thing_id = $1`, [tv]),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('refuse a negative value and a thing of another location', async () => {
    expect(
      (
        await pgError(
          own(
            `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                            created_by)
             VALUES ($1, $2, -1, 'EGP', '2026-09-20', 'estimate', $3)`,
            [ibrahim.locationId, tv, ibrahim.userId],
          ),
        )
      ).constraint,
    ).toBe('valuations_value_chk');
    expect(
      (
        await pgError(
          own(
            `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                            created_by)
             VALUES ($1, $2, 1, 'EGP', '2026-09-20', 'estimate', $3)`,
            [alfred.locationId, tv, alfred.userId],
          ),
        )
      ).constraint,
    ).toBe('valuations_thing_fk');
  });
});

describe('incidents (§7.1: owners and admins)', () => {
  const addIncident = (userId: string, id = newId()) =>
    as(userId, async (c) => {
      await c.query(
        `INSERT INTO public.incidents (id, location_id, kind, occurred_on, created_by)
         VALUES ($1, $2, 'burglary', '2026-09-25', $3)`,
        [id, ibrahim.locationId, userId],
      );
      await c.query(
        `INSERT INTO public.incident_things (location_id, incident_id, thing_id) VALUES ($1, $2, $3)`,
        [ibrahim.locationId, id, tv],
      );
      return id;
    });

  it('are made by owners and admins, not members, and read by viewers', async () => {
    const id = await addIncident(bruce);
    expect((await pgError(addIncident(louis))).code).toBe('42501');
    expect(
      await count(talia, 'SELECT 1 FROM public.incident_things WHERE incident_id = $1', [id]),
    ).toBe(1);
    expect(
      await count(louis, 'DELETE FROM public.incident_things WHERE incident_id = $1', [id]),
    ).toBe(0);
    expect(
      await count(bruce, 'DELETE FROM public.incident_things WHERE incident_id = $1', [id]),
    ).toBe(1);
    expect(await count(alfred.userId, 'SELECT 1 FROM public.incidents WHERE id = $1', [id])).toBe(
      0,
    );
  });

  it('leave an export run of theirs with its pack and no scope when deleted', async () => {
    const id = await addIncident(bruce);
    const run = newId();
    await own(
      `INSERT INTO public.export_runs (id, location_id, kind, incident_id, created_by)
       VALUES ($1, $2, 'claim_pack', $3, $4)`,
      [run, ibrahim.locationId, id, bruce],
    );
    await as(bruce, (c) => c.query('DELETE FROM public.incidents WHERE id = $1', [id]));
    expect(
      await own<{ incident_id: string | null; location_id: string }>(
        'SELECT incident_id, location_id FROM public.export_runs WHERE id = $1',
        [run],
      ),
    ).toEqual([{ incident_id: null, location_id: ibrahim.locationId }]);
  });
});

describe('export runs (D180, Q19)', () => {
  const queue = (userId: string, over: Record<string, unknown> = {}) =>
    as(userId, async (c) => {
      const id = newId();
      const v = { status: 'queued', token: null as string | null, ...over };
      await c.query(
        `INSERT INTO public.export_runs (id, location_id, kind, thing_ids, status, created_by,
                                         token_hash, token_expires_at)
         VALUES ($1, $2, 'claim_pack', ARRAY[$3::uuid], $4, $5, $6,
                 CASE WHEN $6::text IS NULL THEN NULL ELSE now() + interval '1 day' END)`,
        [id, ibrahim.locationId, tv, v.status, userId, v.token ? hash(v.token) : null],
      );
      return id;
    });
  const claim = (userId: string, id: string) =>
    as(userId, (c) => c.query('SELECT * FROM kept.export_run_claim($1)', [id]));
  const finish = (userId: string, id: string) =>
    as(userId, (c) => c.query(`SELECT kept.export_run_finish($1, 4096, 'done', NULL)`, [id]));
  const download = (token: string) =>
    asSystem(async (c) => {
      const { rows } = await c.query<{ storage_key: string; bytes: string; location_id: string }>(
        'SELECT * FROM kept.export_download($1)',
        [hash(token)],
      );
      return rows[0];
    });

  it("are their creator's alone, while they administer the location", async () => {
    const id = await queue(bruce);
    const read = 'SELECT 1 FROM public.export_runs WHERE id = $1';
    expect(await count(bruce, read, [id])).toBe(1);
    // Another admin (the owner) and a member see nothing of it.
    expect(await count(ibrahim.userId, read, [id])).toBe(0);
    expect(await count(louis, read, [id])).toBe(0);
    expect((await pgError(queue(louis))).code).toBe('42501');
    // Made queued, unbuilt: a request can't make a finished run or move it along.
    expect((await pgError(queue(bruce, { status: 'done' }))).code).toBe('42501');
    expect(
      (
        await pgError(
          as(bruce, (c) =>
            c.query(`UPDATE public.export_runs SET status = 'done' WHERE id = $1`, [id]),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      await count(bruce, 'UPDATE public.export_runs SET revoked_at = now() WHERE id = $1', [id]),
    ).toBe(1);
    // Demoted to member, the creator loses it too.
    await own(`UPDATE public.memberships SET role = 'member' WHERE user_id = $1`, [bruce]);
    expect(await count(bruce, read, [id])).toBe(0);
  });

  it('are built through the doors: claimed once, finished at their own key', async () => {
    const id = await queue(bruce, { token: 'pack-1' });
    expect((await pgError(claim(louis, id))).code).toBe('42501');
    expect((await claim(bruce, id)).rows[0]).toMatchObject({
      location_id: ibrahim.locationId,
      kind: 'claim_pack',
      thing_ids: [tv],
      created_by: bruce,
    });
    expect((await pgError(claim(bruce, id))).code).toBe('42501');
    await as(bruce, (c) => c.query('SELECT kept.export_run_progress($1, 3, 10)', [id]));
    expect((await pgError(finish(ibrahim.userId, id))).code).toBe('42501');
    expect(
      (
        await pgError(
          as(bruce, (c) => c.query(`SELECT kept.export_run_finish($1, NULL, 'done', NULL)`, [id])),
        )
      ).code,
    ).toBe('22023');
    await finish(bruce, id);
    const [run] = await own<{ status: string; storage_key: string; progress_done: number }>(
      'SELECT status, storage_key, progress_done FROM public.export_runs WHERE id = $1',
      [id],
    );
    expect(run).toEqual({ status: 'done', storage_key: `x/${id}.zip`, progress_done: 10 });
    // The job may be kept_system's too.
    const other = await queue(bruce);
    await asSystem((c) => c.query('SELECT * FROM kept.export_run_claim($1)', [other]));
    await asSystem((c) =>
      c.query(`SELECT kept.export_run_finish($1, NULL, 'failed', 'too_large')`, [other]),
    );
    expect(
      await own('SELECT status, error, storage_key FROM public.export_runs WHERE id = $1', [other]),
    ).toEqual([{ status: 'failed', error: 'too_large', storage_key: null }]);
  });

  it('download without a session, counted, and re-check the creator (D180)', async () => {
    const id = await queue(bruce, { token: 'pack-2' });
    await claim(bruce, id);
    // Not built yet: no download.
    expect((await pgError(download('pack-2'))).code).toBe('42501');
    await finish(bruce, id);
    expect(await download('pack-2')).toEqual({
      storage_key: `x/${id}.zip`,
      bytes: '4096',
      location_id: ibrahim.locationId,
    });
    await download('pack-2');
    expect(await own('SELECT downloads FROM public.export_runs WHERE id = $1', [id])).toEqual([
      { downloads: 2 },
    ]);
    expect((await pgError(download('no-such-pack'))).code).toBe('42501');
    // The creator demoted: refused, like any unknown link.
    await own(`UPDATE public.memberships SET role = 'member' WHERE user_id = $1`, [bruce]);
    expect((await pgError(download('pack-2'))).code).toBe('42501');
    await own(`UPDATE public.memberships SET role = 'admin' WHERE user_id = $1`, [bruce]);
    expect((await download('pack-2'))?.storage_key).toBe(`x/${id}.zip`);
    // Its link expired, or revoked: refused.
    await own(
      `UPDATE public.export_runs SET token_expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect((await pgError(download('pack-2'))).code).toBe('42501');
    await own(
      `UPDATE public.export_runs SET token_expires_at = now() + interval '1 day', revoked_at = now()
        WHERE id = $1`,
      [id],
    );
    expect((await pgError(download('pack-2'))).code).toBe('42501');
    // kept_app can't open the door at all.
    expect(
      (
        await pgError(
          as(bruce, (c) => c.query('SELECT * FROM kept.export_download($1)', [hash('pack-2')])),
        )
      ).code,
    ).toBe('42501');
  });

  it('expire after seven days: the pack and the link go, the run stays as history', async () => {
    const id = await queue(bruce, { token: 'pack-3' });
    await claim(bruce, id);
    await finish(bruce, id);
    const keep = await queue(bruce);
    await own(
      `UPDATE public.export_runs SET created_at = now() - interval '8 days',
                                     expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    const keys = await asSystem(
      async (c) =>
        (await c.query<{ k: string }>('SELECT k FROM kept.purge_expired_exports(100) AS k')).rows,
    );
    expect(keys).toEqual([{ k: `x/${id}.zip` }]);
    expect(
      await own(
        'SELECT id, status, storage_key, token_hash FROM public.export_runs ORDER BY status',
      ),
    ).toEqual([
      { id, status: 'expired', storage_key: null, token_hash: null },
      { id: keep, status: 'queued', storage_key: null, token_hash: null },
    ]);
    // Refuses a key a caller names: the CHECK holds the run to its own.
    expect(
      (
        await pgError(
          own(`UPDATE public.export_runs SET storage_key = 'f/elsewhere' WHERE id = $1`, [keep]),
        )
      ).constraint,
    ).toBe('export_runs_storage_key_chk');
  });
});

describe('report kinds', () => {
  it('keep existing runs inventory and allow insurance', async () => {
    const [run] = await own<{ kind: string }>(
      `INSERT INTO public.report_runs (user_id, location_id, location_ids)
       VALUES ($1, $2, ARRAY[$2::uuid]) RETURNING kind`,
      [ibrahim.userId, ibrahim.locationId],
    );
    expect(run?.kind).toBe('inventory');
    expect(
      (
        await pgError(
          own(
            `INSERT INTO public.report_runs (user_id, location_id, location_ids, kind)
             VALUES ($1, $2, ARRAY[$2::uuid], 'tax')`,
            [ibrahim.userId, ibrahim.locationId],
          ),
        )
      ).constraint,
    ).toBe('report_runs_kind_chk');
  });
});
