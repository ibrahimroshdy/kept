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
import { withScope } from './scope.js';

// Step-7 T5 (0083): a Kept import carries the exported history as `import` events (plan Q10),
// within the two-year retention, with every month's partition made before its rows arrive.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owner of Home, running the import
let bruce: string; // admin
let louis: string; // member
let run: string;
let thing: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const history = (userId: string, runId: string, events: unknown[]) =>
  as(userId, async (c) => {
    const { rows } = await c.query<{ n: number }>('SELECT kept.import_history($1, $2) AS n', [
      runId,
      JSON.stringify(events),
    ]);
    return rows[0]?.n;
  });
const monthsAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(15);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString();
};
const keptRun = async (userId: string, status = 'running') => {
  const id = newId();
  await own(
    `INSERT INTO public.import_runs (id, location_id, source, status, created_by)
     VALUES ($1, $2, 'kept_zip', $3, $4)`,
    [id, ibrahim.locationId, status, userId],
  );
  return id;
};

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'hist-ibrahim');
  bruce = await seedUser(db, 'hist-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'hist-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  thing = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
    [thing, ibrahim.locationId, ibrahim.unplacedId],
  );
  run = await keptRun(ibrahim.userId);
});

const event = (at: string, extra: Record<string, unknown> = {}) => ({
  at,
  action: 'update',
  entityType: 'thing',
  entityId: thing,
  rootThingId: thing,
  subjects: [thing],
  diff: { name: { before: 'Drill', after: 'Cordless drill', class: 'plain' } },
  actorName: 'Alfred',
  ...extra,
});

describe('kept.import_history (plan Q10)', () => {
  it("writes events as the import, in their own months' partitions, never the default", async () => {
    const at = monthsAgo(18);
    const part = `audit_events_${at.slice(0, 4)}_${at.slice(5, 7)}`;
    expect(await history(ibrahim.userId, run, [event(at), event(monthsAgo(1))])).toBe(2);
    const [made] = await own<{ reg: string | null }>('SELECT to_regclass($1)::text AS reg', [
      `public.${part}`,
    ]);
    expect(made?.reg).toBe(part);
    const [def] = await own<{ n: string }>('SELECT n FROM kept.audit_default_partition_rows()');
    expect(Number(def?.n)).toBe(0);
    // The location's people read it as history, by the import, with the old actor's name.
    const rows = await as(
      bruce,
      async (c) =>
        (
          await c.query<{ actor_type: string; actor_id: string; diff: Record<string, unknown> }>(
            `SELECT actor_type, actor_id, diff FROM public.audit_events
            WHERE location_id = $1 AND actor_type = 'import' ORDER BY at`,
            [ibrahim.locationId],
          )
        ).rows,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_type: 'import', actor_id: run });
    expect(rows[0]?.diff._importedActor).toBe('Alfred');
    const [subjects] = await own<{ n: string }>(
      `SELECT count(*) AS n FROM public.audit_event_subjects WHERE thing_id = $1`,
      [thing],
    );
    expect(Number(subjects?.n)).toBe(2);
  });

  it('drops events past the two-year retention, and the caller counts them', async () => {
    expect(await history(ibrahim.userId, run, [event(monthsAgo(36)), event(monthsAgo(2))])).toBe(1);
  });

  it('refuses a diff that is not one Kept writes: a secret with a value, a stray key', async () => {
    const secret = event(monthsAgo(1), {
      diff: { door_code: { before: '1234', after: '5678', class: 'secret' } },
    });
    expect((await pgError(history(ibrahim.userId, run, [secret]))).code).toBe('22023');
    const stray = event(monthsAgo(1), {
      diff: { name: { before: 'a', after: 'b', class: 'plain', label: 'x' } },
    });
    expect((await pgError(history(ibrahim.userId, run, [stray]))).code).toBe('22023');
    const spoof = event(monthsAgo(1), { diff: { _importedActor: 'Bruce' } });
    expect((await pgError(history(ibrahim.userId, run, [spoof]))).code).toBe('22023');
    const future = event(new Date(Date.now() + 86_400_000).toISOString());
    expect((await pgError(history(ibrahim.userId, run, [future]))).code).toBe('22023');
    // A secret's change as Kept stores it is fine.
    const ok = event(monthsAgo(1), { diff: { door_code: { changed: true, class: 'secret' } } });
    expect(await history(ibrahim.userId, run, [ok])).toBe(1);
  });

  it("is the run's creator's alone, while it runs", async () => {
    expect((await pgError(history(louis, run, [event(monthsAgo(1))]))).code).toBe('42501');
    expect((await pgError(history(bruce, run, [event(monthsAgo(1))]))).code).toBe('42501');
    const done = await keptRun(ibrahim.userId, 'done');
    expect((await pgError(history(ibrahim.userId, done, [event(monthsAgo(1))]))).code).toBe(
      '42501',
    );
  });

  it('leaves kept_app no way to write an import event itself', async () => {
    const direct = as(ibrahim.userId, (c) =>
      c.query(
        `INSERT INTO public.audit_events (location_id, actor_type, actor_id, action, entity_type)
         VALUES ($1, 'import', $2, 'update', 'thing')`,
        [ibrahim.locationId, run],
      ),
    );
    expect((await pgError(direct)).code).toBe('42501');
  });
});
