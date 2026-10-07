import { newId } from '@kept/shared';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { asOwner, seedTenant } from '../../test/tenancy.js';
import { createPools } from './pools.js';
import { locations } from './schema/index.js';
import { ScopeError, withScope, withSystem } from './scope.js';

// Task 11: withScope() / withSystem() (engineering spec §7.1, §7.14).

const db = await testDb();

// One connection per pool, so "the next query on the same pool" is the same backend and a
// setting that leaked out of the transaction would show.
const app = new pg.Pool({ connectionString: db.urls.app, max: 1 });
const system = new pg.Pool({ connectionString: db.urls.system, max: 1 });
app.on('error', () => {});
system.on('error', () => {});

afterAll(async () => {
  await Promise.all([app.end(), system.end()]);
});

beforeEach(async () => {
  await db.reset();
});

async function setting(pool: pg.Pool, name: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT current_setting($1, true) AS v', [name]);
  return rows[0].v;
}

describe('withScope', () => {
  it('sets app.user_id and app.mfa for the transaction only', async () => {
    const userId = newId();
    const seen = await withScope(app, { userId, mfa: true }, async (tx) => {
      const { rows } = await tx.execute<{ uid: string; mfa: string; fn: string; in_tx: boolean }>(
        sql`SELECT current_setting('app.user_id', true) AS uid,
                   current_setting('app.mfa', true) AS mfa,
                   kept.current_user_id()::text AS fn,
                   now() = statement_timestamp() AS in_tx`,
      );
      return rows[0];
    });
    expect(seen).toEqual({ uid: userId, mfa: 'true', fn: userId, in_tx: false });

    // Same backend (max: 1), after the transaction: nothing left behind.
    expect(await setting(app, 'app.user_id')).toBe('');
    expect(await setting(app, 'app.mfa')).toBe('');
    const { rows } = await app.query('SELECT kept.current_user_id() AS uid');
    expect(rows[0].uid).toBeNull();
  });

  it('sets app.token_id for a token principal, and clears it after (step 6, Q6)', async () => {
    const userId = newId();
    const tokenId = newId();
    const seen = await withScope(app, { userId, mfa: false, tokenId }, async (_tx, client) => {
      const { rows } = await client.query('SELECT kept.current_token_id()::text AS t');
      return rows[0].t;
    });
    expect(seen).toBe(tokenId);
    expect(await setting(app, 'app.token_id')).toBe('');
    const none = await withScope(app, { userId, mfa: false }, async (_tx, client) => {
      const { rows } = await client.query('SELECT kept.current_token_id() AS t');
      return rows[0].t;
    });
    expect(none).toBeNull();
    await expect(
      withScope(app, { userId, mfa: false, tokenId: 'kpt_x' }, async () => {}),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it('passes mfa=false through as false', async () => {
    const mfa = await withScope(app, { userId: newId(), mfa: false }, async (_tx, client) => {
      const { rows } = await client.query('SELECT kept.current_mfa() AS mfa');
      return rows[0].mfa;
    });
    expect(mfa).toBe(false);
  });

  it('hands over the raw client on the same transaction (for pg-boss send)', async () => {
    const same = await withScope(app, { userId: newId(), mfa: false }, async (tx, client) => {
      const a = await tx.execute<{ x: string }>(sql`SELECT txid_current()::text AS x`);
      const b = await client.query('SELECT txid_current()::text AS x');
      return a.rows[0]?.x === b.rows[0].x;
    });
    expect(same).toBe(true);
  });

  it('rolls the work back when fn throws, and rethrows the error', async () => {
    const t = await seedTenant(db, 'a');
    const boom = new Error('boom');
    await expect(
      withScope(app, { userId: t.userId, mfa: false }, async (tx) => {
        await tx.update(locations).set({ name: 'Changed' });
        throw boom;
      }),
    ).rejects.toBe(boom);
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT name FROM public.locations WHERE id = $1', [t.locationId]),
    );
    expect(rows[0].name).toBe('Home');
    // The connection went back to the pool clean and usable.
    expect(await setting(app, 'app.user_id')).toBe('');
  });

  it('commits the work when fn returns', async () => {
    const t = await seedTenant(db, 'a');
    await withScope(app, { userId: t.userId, mfa: false }, (tx) =>
      tx.update(locations).set({ name: 'Changed' }),
    );
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT name FROM public.locations WHERE id = $1', [t.locationId]),
    );
    expect(rows[0].name).toBe('Changed');
  });

  it.each([
    ['empty', ''],
    ['not a uuid', 'alice'],
    ['an injection attempt', "x', true); SELECT 1; --"],
  ])('refuses a scope whose userId is %s, before touching the database', async (_label, userId) => {
    let ran = false;
    await expect(
      withScope(app, { userId, mfa: false }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(ScopeError);
    expect(ran).toBe(false);
  });

  it('refuses a non-boolean mfa', async () => {
    await expect(
      withScope(app, { userId: newId(), mfa: 'true' as unknown as boolean }, async () => {}),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it('clears a session-level app.user_id left on a pooled connection', async () => {
    // A stray session-wide set_config (is_local = false) must not become someone's scope.
    await app.query(`SELECT set_config('app.user_id', $1, false)`, [newId()]);
    try {
      const seen = await withSystem(app, async (_tx, client) => {
        const { rows } = await client.query('SELECT kept.current_user_id() AS uid');
        return rows[0].uid;
      });
      expect(seen).toBeNull();
    } finally {
      await app.query('RESET app.user_id');
    }
  });
  it('resets a session-level app.user_id / app.mfa that fn left behind (review, minor)', async () => {
    // is_local = false inside the scope's transaction survives its COMMIT; withScope resets it
    // before the connection goes back to the pool.
    await withScope(app, { userId: newId(), mfa: true }, async (_tx, client) => {
      await client.query(
        `SELECT set_config('app.user_id', $1, false), set_config('app.mfa', 'true', false)`,
        [newId()],
      );
    });
    expect(await setting(app, 'app.user_id')).toBe('');
    expect(await setting(app, 'app.mfa')).toBe('');
  });

  it('refuses tx.transaction() at runtime, not only in the type (review, minor)', async () => {
    const err = await withScope(app, { userId: newId(), mfa: false }, async (tx) => {
      const db = tx as unknown as { transaction: (fn: () => Promise<void>) => Promise<void> };
      return db
        .transaction(async () => {})
        .then(
          () => null,
          (e: unknown) => e,
        );
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
  });
});

describe('withSystem', () => {
  it('runs in a transaction with no user scope', async () => {
    const seen = await withSystem(system, async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT kept.current_user_id() AS uid, kept.current_mfa() AS mfa, current_user AS role,
                now() = statement_timestamp() AS in_tx`,
      );
      return rows[0];
    });
    expect(seen).toEqual({ uid: null, mfa: false, role: 'kept_system', in_tx: false });
  });

  it('rolls back when fn throws', async () => {
    await expect(
      withSystem(system, async (_tx, client) => {
        await client.query(
          `INSERT INTO public.instance_settings (key, value) VALUES ('probe', '1')`,
        );
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    const { rows } = await asOwner(db, (c) =>
      c.query(`SELECT count(*)::int AS n FROM public.instance_settings WHERE key = 'probe'`),
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('createPools', () => {
  it('opens one pool per runtime login, each connecting as its role', async () => {
    const pools = createPools(
      {
        KEPT_DATABASE_URL: db.urls.app,
        KEPT_AUTH_DATABASE_URL: db.urls.auth,
        KEPT_SYSTEM_DATABASE_URL: db.urls.system,
      },
      { max: 1 },
    );
    try {
      const roles = await Promise.all(
        [pools.app, pools.auth, pools.system].map(async (pool) => {
          const { rows } = await pool.query(
            `SELECT current_user AS role, current_setting('application_name') AS app,
                    current_setting('jit') AS jit`,
          );
          return rows[0];
        }),
      );
      // JIT off on every connection (0100's perf fix): compiling cost more than the queries.
      expect(roles).toEqual([
        { role: 'kept_app', app: 'kept-app', jit: 'off' },
        { role: 'kept_auth', app: 'kept-auth', jit: 'off' },
        { role: 'kept_system', app: 'kept-system', jit: 'off' },
      ]);
      // kept_app's timeouts (review, minor): a request can't hold a connection or run away.
      const { rows } = await pools.app.query(
        `SELECT current_setting('statement_timeout') AS statement,
                current_setting('idle_in_transaction_session_timeout') AS idle`,
      );
      expect(rows[0]).toEqual({ statement: '15s', idle: '30s' });
    } finally {
      await Promise.all([pools.app.end(), pools.auth.end(), pools.system.end()]);
    }
  });
});
