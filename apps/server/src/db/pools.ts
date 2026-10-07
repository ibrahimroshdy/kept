import pg from 'pg';

// One pg Pool per runtime login (engineering spec §7.1). kept_owner never gets a pool in the
// serving process: it is used only by `kept migrate` and `kept admin`.

export type Pools = {
  /** kept_app: every request, inside withScope() (db/scope.ts). */
  app: pg.Pool;
  /** kept_auth: Better Auth, schema `auth` only. */
  auth: pg.Pool;
  /** kept_system: cross-tenant jobs and pg-boss, inside withSystem(). */
  system: pg.Pool;
};

export type PoolEnv = {
  KEPT_DATABASE_URL: string;
  KEPT_AUTH_DATABASE_URL: string;
  KEPT_SYSTEM_DATABASE_URL: string;
};

export type PoolOptions = {
  /** Connections per pool. Default 10. */
  max?: number;
  /**
   * A connection whose backend went away (Postgres restarted, PANICked, or ended it) is reported
   * here. `inUse` false: it was idle, and the pool has dropped it. `inUse` true: it was checked
   * out; its owner's pending and next statements fail, and releasing it drops it.
   */
  onError?: (err: Error, pool: keyof Pools, inUse: boolean) => void;
};

/** kept_app's limits: a request can't run a statement for more than 15 s, or sit in an open
 * transaction doing nothing for more than 30 s (holding locks and a pooled connection). The
 * role carries the same defaults (docker/initdb/01-roles.sql; the managed-Postgres SQL must
 * too); setting them here as well means they hold even where the role was made without them. */
export const APP_TIMEOUTS = {
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
} as const;

/**
 * Reports every connection of `pool` whose backend goes away, instead of letting pg's 'error'
 * event end the process. Idle ones: pg-pool listens for their 'error' itself, drops them and
 * re-emits it on the pool. Checked-out ones: pg-pool takes its listener off while a connection is
 * out, so a backend ending under a request or a job (withScope, withSystem, Better Auth's
 * transactions) emitted 'error' with nobody listening, and Node ended the process (2026-09-30,
 * Postgres PANIC 58030). They are listened to from checkout to release; the owner's statements
 * fail, and releasing the connection drops it (pg-pool discards a client that isn't queryable).
 */
export function reportConnectionLoss(
  pool: pg.Pool,
  onError: (err: Error, inUse: boolean) => void,
): void {
  pool.on('error', (err) => onError(err, false));
  const inUse = (err: Error) => onError(err, true);
  pool.on('acquire', (client) => client.on('error', inUse));
  pool.on('release', (_err, client) => client.removeListener('error', inUse));
}

/**
 * Every runtime connection runs with JIT compilation off. Kept's queries are short and many; the
 * planner's cost for a few of them (Home's facts over 10,000 things, a reader of agenda_items)
 * passes jit_above_cost, and compiling took 0.3–3 s a request, far more than the queries
 * themselves (docs/perf/2026-10-06-step5.md, 0100). A session setting: no role or server change.
 */
export const CONNECTION_OPTIONS = '-c jit=off';

export function createPools(env: PoolEnv, opts: PoolOptions = {}): Pools {
  const make = (connectionString: string, name: keyof Pools) => {
    const pool = new pg.Pool({
      connectionString,
      application_name: `kept-${name}`,
      options: CONNECTION_OPTIONS,
      max: opts.max ?? 10,
      ...(name === 'app' ? APP_TIMEOUTS : {}),
    });
    reportConnectionLoss(pool, (err, inUse) => opts.onError?.(err, name, inUse));
    return pool;
  };
  return {
    app: make(env.KEPT_DATABASE_URL, 'app'),
    auth: make(env.KEPT_AUTH_DATABASE_URL, 'auth'),
    system: make(env.KEPT_SYSTEM_DATABASE_URL, 'system'),
  };
}

export async function closePools(pools: Pools): Promise<void> {
  await Promise.all([pools.app.end(), pools.auth.end(), pools.system.end()]);
}
