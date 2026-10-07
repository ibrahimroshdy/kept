import { createHash } from 'node:crypto';
import type pg from 'pg';

// D172, engineering spec §3.2: sign-in attempts are limited per account *and* IP, 20 per hour,
// with progressive delays rather than a lockout, so nobody can lock someone else out. Better
// Auth's own limiter (also on, database-backed) keys on IP + path only, so this is Kept's.
// State lives in auth.sign_in_failures and every decision uses the database clock, so replicas
// agree (V32).
//
// An attempt is *reserved* before the credential is checked, in one atomic upsert that both
// decides and counts (Phase B review, item 1). Checking first and counting the failure
// afterwards let parallel requests all pass the check before any of them was counted. So every
// attempt counts as a failure until it succeeds, and success deletes the row.

export const WINDOW_SECONDS = 3600;
export const MAX_FAILURES = 20;
/** Failures allowed before delays start. */
export const FREE_FAILURES = 4;
export const MAX_DELAY_SECONDS = 300;

/** Seconds the next attempt must wait after `failures` failures in the current window. */
export function delayAfter(failures: number): number {
  if (failures <= FREE_FAILURES) return 0;
  return Math.min(2 ** (failures - FREE_FAILURES), MAX_DELAY_SECONDS);
}

/** A stable, non-reversible key: the raw identifier and IP are never stored. */
export function limiterKey(
  kind:
    | 'password'
    | 'second-factor'
    | 'reset-code'
    | 'magic-link'
    | 'password-reset'
    | 'email-change'
    | 'sign-up'
    | 'sign-up-existing'
    | 'reset-code-ip'
    | 'token-ip'
    | 'magic-link-address'
    | 'password-reset-address'
    | 'setup-code'
    | 'setup-code-all'
    | 'move-preview'
    | 'secret-reveal'
    | 'barcode-lookup'
    // Step 4 (T15, T17): a channel's test send; a calendar feed's fetches.
    | 'channel-test'
    | 'calendar-feed'
    // Step 6 (T15): a location webhook's test ping.
    | 'webhook-test'
    // Step 7 (T14): a Kept import's passphrase tries, per run.
    | 'import-passphrase',
  ...parts: string[]
): string {
  const normalised = parts.map((p) => p.trim().toLowerCase());
  return createHash('sha256')
    .update([kind, ...normalised].join('\0'))
    .digest('hex');
}

export type LimiterDecision = { allowed: true } | { allowed: false; retryAfter: number };

// SQL for one row alias (`f` = the stored row inside ON CONFLICT, `old` = the same row as it was
// before the statement, in RETURNING; Postgres 18). $2 window, $3 max failures, $4 free
// failures, $5 max delay. `delayAfter()` above is the same formula.
const lapsed = (r: string) => `(${r}.window_start <= now() - make_interval(secs => $2))`;
const delay = (r: string) =>
  `(CASE WHEN ${r}.count <= $4 THEN 0 ELSE least(power(2, ${r}.count - $4), $5) END)`;
const allowed = (r: string) =>
  `(${r}.count < $3 AND extract(epoch FROM now() - ${r}.last_failure_at) >= ${delay(r)})`;

const RESERVE_SQL = `
INSERT INTO auth.sign_in_failures AS f (key, window_start, count, last_failure_at)
VALUES ($1, now(), 1, now())
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN ${lapsed('f')} THEN 1
               WHEN ${allowed('f')} THEN f.count + 1
               ELSE f.count END,
  last_failure_at = CASE WHEN ${lapsed('f')} OR ${allowed('f')} THEN now()
                         ELSE f.last_failure_at END,
  window_start = CASE WHEN ${lapsed('f')} THEN now() ELSE f.window_start END
RETURNING
  (old.key IS NULL OR ${lapsed('old')} OR ${allowed('old')}) AS reserved,
  (CASE WHEN old.count >= $3
        THEN extract(epoch FROM old.window_start + make_interval(secs => $2) - now())
        ELSE ${delay('old')} - extract(epoch FROM now() - old.last_failure_at)
   END)::float8 AS retry_after`;

/**
 * Reserves one attempt for `key`: counts it as a failure and allows it, or refuses it (counting
 * nothing) while the key is delayed or at the hourly cap. Atomic: concurrent calls for one key
 * serialise on the row, so no more attempts get through than the limit allows. Call
 * `clearSignInFailures()` when the attempt succeeds.
 */
export async function reserveSignInAttempt(pool: pg.Pool, key: string): Promise<LimiterDecision> {
  const { rows } = await pool.query<{ reserved: boolean; retry_after: number | null }>(
    RESERVE_SQL,
    [key, WINDOW_SECONDS, MAX_FAILURES, FREE_FAILURES, MAX_DELAY_SECONDS],
  );
  const row = rows[0];
  if (!row || row.reserved) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil(row.retry_after ?? 1)) };
}

export async function clearSignInFailures(pool: pg.Pool, key: string): Promise<void> {
  await pool.query('DELETE FROM auth.sign_in_failures WHERE key = $1', [key]);
}

// Mailed links (engineering spec §3.2: password reset and magic link, 3 per hour per account;
// Kept applies the same to email-change confirmations). Not failures: every request counts, and
// nothing clears the count early. A plain fixed window in the same table, so the nightly prune
// (task 24) covers it too. `count` stops at the cap, so a refused request changes nothing.
const RESERVE_IN_WINDOW_SQL = `
INSERT INTO auth.sign_in_failures AS f (key, window_start, count, last_failure_at)
VALUES ($1, now(), 1, now())
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN ${lapsed('f')} THEN 1
               WHEN f.count < $3 THEN f.count + 1
               ELSE f.count END,
  last_failure_at = CASE WHEN ${lapsed('f')} OR f.count < $3 THEN now() ELSE f.last_failure_at END,
  window_start = CASE WHEN ${lapsed('f')} THEN now() ELSE f.window_start END
RETURNING
  (old.key IS NULL OR ${lapsed('old')} OR old.count < $3) AS reserved,
  extract(epoch FROM old.window_start + make_interval(secs => $2) - now())::float8 AS retry_after`;

/** Reserves one of `max` uses of `key` in a fixed window of `windowSeconds`. Atomic, like
 * reserveSignInAttempt(); refused requests are not counted. */
export async function reserveInWindow(
  pool: pg.Pool,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<LimiterDecision> {
  const { rows } = await pool.query<{ reserved: boolean; retry_after: number | null }>(
    RESERVE_IN_WINDOW_SQL,
    [key, windowSeconds, max],
  );
  const row = rows[0];
  if (!row || row.reserved) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil(row.retry_after ?? 1)) };
}

/** §3.2: mailed links per account, counted per (address, client IP) (security review M4), so
 * nobody elsewhere can use up someone's allowance and block their sign-in. */
export const MAIL_LINKS_PER_HOUR = 3;
/** ...and a ceiling per address across every IP, so a botnet can't flood one mailbox. */
export const MAIL_LINKS_PER_ADDRESS_PER_HOUR = 10;

// A lockout (the setup code, task 22): `max` attempts, each within `lockSeconds` of the one
// before, then nothing for `lockSeconds` after the last of them. An attempt counts until
// clearSignInFailures() says it succeeded; a quiet spell as long as the lockout starts afresh.
// $2 max, $3 lock seconds.
const locked = (r: string) =>
  `(${r}.count >= $2 AND ${r}.last_failure_at > now() - make_interval(secs => $3))`;
const quiet = (r: string) => `(${r}.last_failure_at <= now() - make_interval(secs => $3))`;

const RESERVE_WITH_LOCKOUT_SQL = `
INSERT INTO auth.sign_in_failures AS f (key, window_start, count, last_failure_at)
VALUES ($1, now(), 1, now())
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN ${locked('f')} THEN f.count WHEN ${quiet('f')} THEN 1 ELSE f.count + 1 END,
  last_failure_at = CASE WHEN ${locked('f')} THEN f.last_failure_at ELSE now() END,
  window_start = CASE WHEN ${locked('f')} THEN f.window_start
                      WHEN ${quiet('f')} THEN now() ELSE f.window_start END
RETURNING
  (old.key IS NULL OR NOT ${locked('old')}) AS reserved,
  extract(epoch FROM old.last_failure_at + make_interval(secs => $3) - now())::float8 AS retry_after`;

/** Reserves one of `max` attempts before a `lockSeconds` lockout. Atomic, like the others. */
export async function reserveWithLockout(
  pool: pg.Pool,
  key: string,
  max: number,
  lockSeconds: number,
): Promise<LimiterDecision> {
  const { rows } = await pool.query<{ reserved: boolean; retry_after: number | null }>(
    RESERVE_WITH_LOCKOUT_SQL,
    [key, max, lockSeconds],
  );
  const row = rows[0];
  if (!row || row.reserved) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil(row.retry_after ?? 1)) };
}
