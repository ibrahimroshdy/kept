import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { withScope, withSystem } from './scope.js';

// Step-7 T4 (0079, 0080): export runs for Kept exports beside step 4's claim packs, archive
// import runs with no target yet, Homebox source ids, and the pruning of abandoned runs
// (engineering spec §1.10, §3.3, §7.1; D68, D146, D180; plan Q2, Q7, Q14, Q18).

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owner of Home
let bruce: string; // admin
let louis: string; // member
let talia: string; // viewer

const SEALED = JSON.stringify({ v: 1, kv: 1, dek: 'ZGVr', iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' });
const SHA = 'b'.repeat(64);

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const count = (userId: string, sql: string, values: unknown[] = []) =>
  as(userId, async (c) => (await c.query(sql, values)).rowCount ?? 0);

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'port-ibrahim');
  bruce = await seedUser(db, 'port-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'port-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  talia = await seedUser(db, 'port-talia');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
});

/** Inserts a queued Kept export as `userId`, under the policies. */
const exportAs = (
  userId: string,
  opts: { kind?: string; location?: string; secrets?: boolean } = {},
) =>
  as(userId, async (c) => {
    const id = newId();
    const secrets = opts.secrets ?? false;
    await c.query(
      `INSERT INTO public.export_runs (id, location_id, kind, include_secrets, options, created_by,
                                       secrets_key_ciphertext, key_version)
       VALUES ($1, $2, $3, $4, '{"history": true}', $5, $6, $7)`,
      [
        id,
        opts.location ?? ibrahim.locationId,
        opts.kind ?? 'location',
        secrets,
        userId,
        secrets ? SEALED : null,
        secrets ? 1 : null,
      ],
    );
    return id;
  });

const exportRow = async (id: string) =>
  (
    await own<{
      status: string;
      error: string | null;
      secrets_key_ciphertext: unknown;
      key_version: number | null;
      sha256: string | null;
      storage_key: string | null;
      started_at: Date | null;
      days: number | null;
    }>(
      `SELECT status, error, secrets_key_ciphertext, key_version, sha256, storage_key, started_at,
              (extract(epoch FROM expires_at - now()) / 86400)::float8 AS days
         FROM public.export_runs WHERE id = $1`,
      [id],
    )
  )[0];

describe('export runs (D68, D180, plan Q14)', () => {
  it('are made by owners and admins; "Include secrets" and its sealed key only by the owner', async () => {
    expect((await pgError(exportAs(louis))).code).toBe('42501');
    expect((await pgError(exportAs(talia))).code).toBe('42501');
    await exportAs(bruce);
    expect((await pgError(exportAs(bruce, { secrets: true }))).code).toBe('42501');
    const mine = await exportAs(ibrahim.userId, { secrets: true });
    expect((await exportRow(mine))?.key_version).toBe(1);
    // A sealed key needs "Include secrets"; a Kept export names no incident or things.
    const bad = await pgError(
      own(
        `INSERT INTO public.export_runs (location_id, kind, created_by, secrets_key_ciphertext,
                                         key_version)
         VALUES ($1, 'location', $2, $3, 1)`,
        [ibrahim.locationId, ibrahim.userId, SEALED],
      ),
    );
    expect(bad.constraint).toBe('export_runs_secrets_key_chk');
    const scoped = await pgError(
      own(
        `INSERT INTO public.export_runs (location_id, kind, thing_ids, created_by)
         VALUES ($1, 'location', ARRAY[$2::uuid], $3)`,
        [ibrahim.locationId, newId(), ibrahim.userId],
      ),
    );
    expect(scoped.constraint).toBe('export_runs_kind_scope_chk');
  });

  it('"Export my data" is of the requester\'s own Personal location only', async () => {
    expect((await pgError(exportAs(ibrahim.userId, { kind: 'me' }))).code).toBe('42501');
    const personal = await ownerTx(db, (c) =>
      insertLocation(
        c,
        { userId: ibrahim.userId, accountId: ibrahim.accountId },
        { kind: 'personal', name: 'Personal' },
      ),
    );
    await exportAs(ibrahim.userId, { kind: 'me', location: personal.locationId });
    expect(
      (await pgError(exportAs(bruce, { kind: 'me', location: personal.locationId }))).code,
    ).toBe('42501');
  });

  it("are the creator's alone, and a demoted admin loses his at once, its key with it", async () => {
    const run = await exportAs(bruce);
    const read = 'SELECT 1 FROM public.export_runs WHERE id = $1';
    expect(await count(bruce, read, [run])).toBe(1);
    expect(await count(ibrahim.userId, read, [run])).toBe(0);
    await as(bruce, (c) => c.query('SELECT * FROM kept.export_run_claim($1)', [run]));
    expect((await exportRow(run))?.started_at).not.toBeNull();

    const owners = await exportAs(ibrahim.userId, { secrets: true });
    await own(
      `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
      [ibrahim.locationId, bruce],
    );
    expect(await count(bruce, read, [run])).toBe(0);
    expect(await exportRow(run)).toMatchObject({ status: 'failed', error: 'not_permitted' });
    // Only his: the owner's run is untouched.
    expect(await exportRow(owners)).toMatchObject({ status: 'queued', key_version: 1 });
  });

  it("finish: done records the SHA-256 and seven days from now, cancel is the creator's, and the key always goes", async () => {
    const run = await exportAs(ibrahim.userId, { secrets: true });
    await own(`UPDATE public.export_runs SET expires_at = now() + interval '1 day' WHERE id = $1`, [
      run,
    ]);
    await as(ibrahim.userId, async (c) => {
      await c.query('SELECT * FROM kept.export_run_claim($1)', [run]);
      await c.query(`SELECT kept.export_run_finish($1, 4096, 'done', NULL, $2)`, [run, SHA]);
    });
    const done = await exportRow(run);
    expect(done).toMatchObject({
      status: 'done',
      sha256: SHA,
      storage_key: `x/${run}.zip`,
      secrets_key_ciphertext: null,
      key_version: null,
    });
    expect(done?.days).toBeGreaterThan(6.9);

    const other = await exportAs(ibrahim.userId, { secrets: true });
    // Bruce can't see it, so can't cancel it.
    expect(
      (
        await pgError(
          as(bruce, (c) =>
            c.query(`SELECT kept.export_run_finish($1, NULL, 'cancelled', NULL)`, [other]),
          ),
        )
      ).code,
    ).toBe('42501');
    await as(ibrahim.userId, (c) =>
      c.query(`SELECT kept.export_run_finish($1, NULL, 'cancelled', NULL)`, [other]),
    );
    expect(await exportRow(other)).toMatchObject({ status: 'cancelled', key_version: null });
    // The job's next step after a cancel is refused, so it stops.
    expect(
      (
        await pgError(
          as(ibrahim.userId, (c) => c.query('SELECT kept.export_run_progress($1, 1, 2)', [other])),
        )
      ).code,
    ).toBe('42501');
  });

  it('the purge fails a run its job abandoned and clears its key; a claim pack is left as it was', async () => {
    const run = await exportAs(ibrahim.userId, { secrets: true });
    const fresh = await exportAs(ibrahim.userId);
    await own(
      `UPDATE public.export_runs SET status = 'running', started_at = now() - interval '4 hours'
        WHERE id = $1`,
      [run],
    );
    await asSystem((c) => c.query('SELECT kept.purge_expired_exports(100)'));
    expect(await exportRow(run)).toMatchObject({
      status: 'failed',
      error: 'abandoned',
      key_version: null,
    });
    expect((await exportRow(fresh))?.status).toBe('queued');
  });

  it('the doors stay where they belong', async () => {
    for (const sql of [
      'SELECT kept.purge_expired_exports(10)',
      'SELECT * FROM kept.stale_import_runs(now(), 10)',
      `SELECT kept.clear_import_run('${newId()}')`,
    ]) {
      expect((await pgError(as(ibrahim.userId, (c) => c.query(sql)))).code).toBe('42501');
    }
    expect(
      (
        await pgError(
          asSystem((c) => c.query(`SELECT kept.set_import_target($1, $2)`, [newId(), newId()])),
        )
      ).code,
    ).toBe('42501');
  });
});

/** A Homebox archive run with no target, as `userId`. */
const draftAs = (userId: string) =>
  as(userId, async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.import_runs (id, source, created_by, archive_bytes, archive_sha256)
       VALUES ($1, 'homebox_zip', $2, 4096, $3)`,
      [id, userId, SHA],
    );
    return id;
  });

describe('archive import runs (plan T8, Q8, Q18)', () => {
  it("a run with no target is its creator's alone", async () => {
    const run = await draftAs(bruce);
    const read = 'SELECT 1 FROM public.import_runs WHERE id = $1';
    expect(await count(bruce, read, [run])).toBe(1);
    expect(await count(ibrahim.userId, read, [run])).toBe(0);
    // Only an archive starts without a target, and only as a draft.
    const csv = await pgError(
      as(bruce, (c) =>
        c.query(`INSERT INTO public.import_runs (source, created_by) VALUES ('csv', $1)`, [bruce]),
      ),
    );
    expect(csv.code).toBe('42501');
    const status = await pgError(
      own(
        `INSERT INTO public.import_runs (source, status, created_by)
         VALUES ('kept_zip', 'running', $1)`,
        [bruce],
      ),
    );
    expect(status.constraint).toBe('import_runs_target_chk');
    // A failed inspection keeps it without a target, still his.
    expect(
      await count(bruce, `UPDATE public.import_runs SET status = 'failed' WHERE id = $1`, [run]),
    ).toBe(1);
  });

  it('its target is set once, by its creator, to a location he administers', async () => {
    const run = await draftAs(bruce);
    const target = (userId: string, location: string) =>
      as(userId, (c) => c.query('SELECT kept.set_import_target($1, $2)', [run, location]));
    const other = await seedTenant(db, 'port-alfred');
    expect((await pgError(target(bruce, other.locationId))).code).toBe('42501');
    expect((await pgError(target(ibrahim.userId, ibrahim.locationId))).code).toBe('42501');
    // kept_app holds no grant on the location itself.
    expect(
      (
        await pgError(
          as(bruce, (c) =>
            c.query('UPDATE public.import_runs SET location_id = $2 WHERE id = $1', [
              run,
              ibrahim.locationId,
            ]),
          ),
        )
      ).code,
    ).toBe('42501');
    await target(bruce, ibrahim.locationId);
    // Now the location's admins see it, the owner included.
    expect(
      await count(ibrahim.userId, 'SELECT 1 FROM public.import_runs WHERE id = $1', [run]),
    ).toBe(1);
    const again = await pgError(target(bruce, ibrahim.locationId));
    expect(again).toMatchObject({ code: '23514', constraint: 'import_runs_target_fixed' });

    const louisRun = await draftAs(louis);
    expect(
      (
        await pgError(
          as(louis, (c) =>
            c.query('SELECT kept.set_import_target($1, $2)', [louisRun, ibrahim.locationId]),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('a demoted admin loses his unfinished imports into the location', async () => {
    const run = await draftAs(bruce);
    await as(bruce, (c) =>
      c.query('SELECT kept.set_import_target($1, $2)', [run, ibrahim.locationId]),
    );
    await own(
      `UPDATE public.memberships SET role = 'viewer' WHERE location_id = $1 AND user_id = $2`,
      [ibrahim.locationId, bruce],
    );
    const [row] = await own<{ status: string }>(
      'SELECT status FROM public.import_runs WHERE id = $1',
      [run],
    );
    expect(row?.status).toBe('cancelled');
  });

  it('source ids take `homebox` from either Homebox path, and the wider entity list', async () => {
    const run = await draftAs(bruce);
    await as(bruce, (c) =>
      c.query('SELECT kept.set_import_target($1, $2)', [run, ibrahim.locationId]),
    );
    await as(bruce, (c) =>
      c.query(
        `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type,
                                               entity_id, run_id)
         VALUES ($1, 'homebox', 'hb-1', 'tag', $2, $3), ($1, 'homebox', 'hb-2', 'stock_rule', $4, $3)`,
        [ibrahim.locationId, newId(), run, newId()],
      ),
    );
    const dup = await pgError(
      as(bruce, (c) =>
        c.query(
          `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type,
                                                 entity_id, run_id)
           VALUES ($1, 'homebox', 'hb-1', 'tag', $2, $3)`,
          [ibrahim.locationId, newId(), run],
        ),
      ),
    );
    expect(dup.code).toBe('23505');
  });

  it('the prune finds abandoned runs and clears them, and leaves a running run alone', async () => {
    const draft = await draftAs(bruce);
    const running = await draftAs(ibrahim.userId);
    await as(ibrahim.userId, (c) =>
      c.query('SELECT kept.set_import_target($1, $2)', [running, ibrahim.locationId]),
    );
    await own(`UPDATE public.import_runs SET status = 'running' WHERE id = $1`, [running]);
    // Everything here was touched just now: a cutoff a day ahead stands in for a week ago.
    const stale = await asSystem(
      async (c) =>
        (
          await c.query<{ id: string; has_archive: boolean }>(
            `SELECT * FROM kept.stale_import_runs(now() + interval '1 day', 100)`,
          )
        ).rows,
    );
    expect(stale).toEqual([{ id: draft, has_archive: true }]);
    expect(
      await asSystem(
        async (c) =>
          (await c.query(`SELECT * FROM kept.stale_import_runs(now() - interval '7 days', 100)`))
            .rows,
      ),
    ).toEqual([]);
    await asSystem((c) => c.query('SELECT kept.clear_import_run($1)', [draft]));
    const [row] = await own<{ status: string; archive_bytes: string | null }>(
      'SELECT status, archive_bytes FROM public.import_runs WHERE id = $1',
      [draft],
    );
    expect(row).toEqual({ status: 'cancelled', archive_bytes: null });
    // Cleared: it isn't found again.
    expect(
      await asSystem(
        async (c) =>
          (await c.query(`SELECT * FROM kept.stale_import_runs(now() + interval '1 day', 100)`))
            .rows,
      ),
    ).toEqual([]);
  });
});

describe('the AI ledger (plan Q21)', () => {
  it('records alias enrichment against the extraction budget', async () => {
    const [row] = await own<{ budget_task: string }>(
      `INSERT INTO public.llm_calls (request_id, task, paying_scope, provider_kind, model, sent,
                                     outcome, cost_source)
       VALUES ('r-enrich', 'enrich_aliases', 'instance', 'groq', 'm', false, 'over_budget',
               'not_sent')
       RETURNING budget_task`,
    );
    expect(row?.budget_task).toBe('extraction');
  });
});
