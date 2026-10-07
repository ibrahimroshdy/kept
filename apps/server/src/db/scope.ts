import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from './schema/index.js';

// Every request, and every tenant job, runs inside withScope(): one explicit transaction on a
// kept_app connection with `app.user_id`, `app.mfa` and `app.token_id` set transaction-locally
// (engineering spec §7.1, §7.14; step-6 plan Q6). Row-level security reads them through kept.current_user_id() and
// kept.current_mfa(); unset, every policy denies, so a query that skipped the wrapper sees
// nothing (fail closed, D178). Cross-tenant jobs run inside withSystem() on kept_system.

/** The Drizzle handle inside a scope. `transaction()` is left out on purpose: on a connection
 * that is already in withScope's transaction it would send a second BEGIN and then COMMIT the
 * scope's transaction early, after which the rest of `fn` would run outside it with no scope.
 * The type leaves it out, and at runtime it throws a ScopeError (for a cast past the type). */
export type Tx = Omit<NodePgDatabase<typeof schema>, 'transaction'>;

export type Scope = {
  /** The Better Auth user id (`auth.user.id`, a UUID). */
  userId: string;
  /** Whether this session passed a second factor (§7.14); gates `require_2fa` locations. For a
   * token it is the token's `created_with_mfa` (kept.token_verify). */
  mfa: boolean;
  /** A personal token or OAuth grant acting as `userId` (step 6, Q6): RLS then sees only the
   * token's locations, and nothing to write with a read token (0070). */
  tokenId?: string;
};

export type ScopeErrorCode = 'invalid_scope';

export class ScopeError extends Error {
  readonly code: ScopeErrorCode = 'invalid_scope';

  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScopedFn<T> = (tx: Tx, client: pg.PoolClient) => Promise<T>;

/** A Drizzle handle on `client` whose `transaction()` throws instead of committing early. */
function scopedDrizzle(client: pg.PoolClient): Tx {
  const db = drizzle(client, { schema });
  Object.defineProperty(db, 'transaction', {
    value: () => {
      throw new ScopeError('transaction() is not available inside withScope/withSystem');
    },
  });
  return db;
}

async function inTx<T>(
  pool: pg.Pool,
  userId: string,
  mfa: boolean,
  tokenId: string,
  fn: ScopedFn<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN').catch((err: Error) => {
      broken = err;
      throw err;
    });
    try {
      // Always all three, even for withSystem (''/false/''): a session-level value someone left
      // on this pooled connection must never become the scope.
      await client.query(
        `SELECT set_config('app.user_id', $1, true), set_config('app.mfa', $2, true),
                set_config('app.token_id', $3, true)`,
        [userId, String(mfa), tokenId],
      );
      const result = await fn(scopedDrizzle(client), client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr: Error) => {
        // The connection is in an unknown state: destroy it rather than reuse it.
        broken = rollbackErr;
      });
      throw err;
    }
  } finally {
    // The scope is transaction-local, but `fn` could have set it session-wide (is_local =
    // false), which outlives COMMIT. Clear all three before the connection serves anyone else.
    if (!broken) {
      await client
        .query('RESET app.user_id; RESET app.mfa; RESET app.token_id')
        .catch((resetErr: Error) => {
          broken = resetErr;
        });
    }
    client.release(broken);
  }
}

/** Runs `fn` in one transaction on `pool` (kept_app) as `scope.userId`. The raw `client` is the
 * same connection and transaction, for pg-boss `send()` (jobs/boss.ts `sendInTx`). */
export function withScope<T>(pool: pg.Pool, scope: Scope, fn: ScopedFn<T>): Promise<T> {
  if (typeof scope.userId !== 'string' || !UUID.test(scope.userId)) {
    return Promise.reject(new ScopeError('scope.userId must be a UUID'));
  }
  if (typeof scope.mfa !== 'boolean') {
    return Promise.reject(new ScopeError('scope.mfa must be a boolean'));
  }
  if (
    scope.tokenId !== undefined &&
    (typeof scope.tokenId !== 'string' || !UUID.test(scope.tokenId))
  ) {
    return Promise.reject(new ScopeError('scope.tokenId must be a UUID'));
  }
  return inTx(pool, scope.userId.toLowerCase(), scope.mfa, scope.tokenId?.toLowerCase() ?? '', fn);
}

/** Runs `fn` in one transaction on `pool` (kept_system) with no user scope. kept_system reads
 * only the tables whose `system` policies allow it (§7.1). */
export function withSystem<T>(pool: pg.Pool, fn: ScopedFn<T>): Promise<T> {
  return inTx(pool, '', false, '', fn);
}
