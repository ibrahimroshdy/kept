import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { type AuditActor, audited } from '../audit/audited.js';
import { isUndeliverableEmail, MANAGED_EMAIL_DOMAIN } from '../auth/emails.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';

// ensureAccount() (task 18; D114, D190, §7.14): the second step of account creation. Better Auth
// (kept_auth) creates the user; this makes the owner account, the Personal location with its
// owner membership and Unplaced area, and the profile, all through kept.ensure_account()
// (migration 0007) in one transaction. Idempotent and safe to race: the function takes a per-user
// advisory lock and creates only what is missing. It runs
// - from Better Auth's user-created hook (after the auth transaction commits),
// - on every signed-in request, behind a per-process cache (accountEnsurer().onScope),
// - from the hourly `repair-orphans` job, as kept_system (repairOrphanAccounts()).
// Consuming an invite (the plan's `opts.inviteToken`) is task 20's: kept.accept_invite().

/** The header the web app sends with the browser's IANA time zone (Intl's resolvedOptions). */
export const TIMEZONE_HEADER = 'x-kept-timezone';

export type AccountDefaults = { timezone: string; locale: string; currency: string };

export const FALLBACK_DEFAULTS: AccountDefaults = Object.freeze({
  timezone: 'UTC',
  locale: 'en',
  currency: 'USD',
});

/** Eurozone members (Bulgaria from 2026-01-01) and the states that use the euro by agreement. */
const EURO_REGIONS = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
  'AD',
  'MC',
  'SM',
  'VA',
]);

/** The Personal location's currency from the locale's region (task 18): EG → EGP, GB → GBP,
 * CA → CAD, a euro region → EUR, anything else (or no region) → USD. */
export function currencyForLocale(locale: string): string {
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).region;
  } catch {
    return 'USD';
  }
  if (region === 'EG') return 'EGP';
  if (region === 'GB') return 'GBP';
  if (region === 'CA') return 'CAD';
  if (region && EURO_REGIONS.has(region)) return 'EUR';
  return 'USD';
}

/** The first Accept-Language tag, canonicalised; null when there is none worth using. */
export function localeFromAcceptLanguage(value: string | null | undefined): string | null {
  const first = value?.split(',')[0]?.split(';')[0]?.trim();
  if (!first || first === '*' || first.length > 35) return null;
  try {
    return Intl.getCanonicalLocales(first)[0] ?? null;
  } catch {
    return null;
  }
}

/** An IANA time zone the runtime knows, or null. */
export function validTimeZone(value: string | null | undefined): string | null {
  const zone = value?.trim();
  if (!zone || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Profile and Personal-location defaults from the request that created the account. */
export function defaultsFromHeaders(headers: Headers | undefined): AccountDefaults {
  const locale =
    localeFromAcceptLanguage(headers?.get('accept-language')) ?? FALLBACK_DEFAULTS.locale;
  return {
    timezone: validTimeZone(headers?.get(TIMEZONE_HEADER)) ?? FALLBACK_DEFAULTS.timezone,
    locale,
    currency: currencyForLocale(locale),
  };
}

export type EnsuredAccount = {
  ownerAccountId: string;
  personalLocationId: string;
  /** Whether this call created the Personal location (and so everything with it). */
  created: boolean;
};

type EnsureRow = {
  owner_account_id: string;
  location_id: string;
  created: boolean;
  timezone: string;
  currency: string;
};

/** kept.ensure_account() for the scope's user, plus the audit event when it created the
 * location. Runs inside the caller's withScope() (kept_app or kept_system). */
async function ensureInScope(
  tx: Tx,
  client: pg.ClientBase,
  defaults: AccountDefaults,
  actor: AuditActor,
  requestId: string | null,
): Promise<EnsuredAccount> {
  const { rows } = await client.query<EnsureRow>('SELECT * FROM kept.ensure_account($1, $2, $3)', [
    defaults.timezone,
    defaults.locale,
    defaults.currency,
  ]);
  const row = rows[0];
  if (!row) throw new Error('kept.ensure_account() returned no row');
  if (row.created) {
    // After the owner membership exists, so the location is visible to the user's own audit
    // policy (kept_app); kept_system writes it through its system_insert policy.
    await audited(tx, {
      locationId: row.location_id,
      ownerAccountId: row.owner_account_id,
      actor,
      action: 'location.create',
      entity: { type: 'location', id: row.location_id },
      after: {
        kind: 'personal',
        name: 'Personal',
        preset: 'household',
        timezone: row.timezone,
        currency: row.currency,
      },
      requestId,
    });
  }
  return {
    ownerAccountId: row.owner_account_id,
    personalLocationId: row.location_id,
    created: row.created,
  };
}

export type EnsureOptions = {
  /** The creating request's headers: Accept-Language and x-kept-timezone give the defaults. */
  headers?: Headers;
  requestId?: string;
};

/** Makes sure `userId` has an owner account, a Personal location and a profile, as that user,
 * in one kept_app transaction. The scope has `mfa: true`: the account is the user's own and
 * brand new, and nothing else is read or written in it. */
export function ensureAccount(
  pools: Pick<Pools, 'app'>,
  userId: string,
  opts: EnsureOptions = {},
): Promise<EnsuredAccount> {
  const defaults = defaultsFromHeaders(opts.headers);
  return withScope(pools.app, { userId, mfa: true }, (tx, client) =>
    ensureInScope(tx, client, defaults, { type: 'user', id: userId }, opts.requestId ?? null),
  );
}

/** ensureAccount's work for `userId` as kept_system, scoped to that user and audited as
 * `system`: for an account someone else created (a managed account, task 21, D114), whose own
 * scope Kept never holds. */
export function ensureAccountAsSystem(
  pools: Pick<Pools, 'system'>,
  userId: string,
): Promise<EnsuredAccount> {
  return withScope(pools.system, { userId, mfa: false }, (tx, client) =>
    ensureInScope(tx, client, FALLBACK_DEFAULTS, { type: 'system', id: null }, null),
  );
}

/** How long a new auth user is left to its own sign-up hook before the job steps in, so the job
 * never beats the hook to it and gives someone UTC/en/USD instead of their browser's defaults. */
export const ORPHAN_GRACE_SECONDS = 5 * 60;

export type RepairResult = {
  repaired: string[];
  /** Half-made managed accounts deleted (see below). */
  removed: string[];
  failed: { userId: string; error: unknown }[];
};

/**
 * The `repair-orphans` job (§7.14): every auth user older than the grace period with no owner
 * account or no profile gets ensureAccount's work, one kept_system transaction per user (scoped
 * to that user, so kept.ensure_account() makes theirs and nothing else), audited as `system`.
 * kept_system reads only auth.user's id and created_at (migration 0007).
 *
 * A managed account (`@managed.invalid`, D47) with no profile is a create that failed after
 * Better Auth made its user and whose clean-up failed too (managed/routes.ts): ensuring it would
 * make it an ordinary account, so it is deleted instead, through kept_auth (security review M5).
 * A managed account *with* its profile only lacks its owner account and Personal location
 * (D114), and gets them like anyone else.
 */
export async function repairOrphanAccounts(
  pools: Pick<Pools, 'system' | 'auth'>,
  opts: { limit?: number; graceSeconds?: number } = {},
): Promise<RepairResult> {
  const { rows } = await pools.system.query<{ id: string; has_profile: boolean }>(
    `SELECT u.id,
            EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.user_id = u.id) AS has_profile
       FROM auth."user" u
      WHERE u.created_at < now() - make_interval(secs => $1)
        AND (NOT EXISTS (SELECT 1 FROM public.owner_accounts oa WHERE oa.user_id = u.id)
             OR NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.user_id = u.id))
      ORDER BY u.created_at
      LIMIT $2`,
    [opts.graceSeconds ?? ORPHAN_GRACE_SECONDS, opts.limit ?? 500],
  );
  const result: RepairResult = { repaired: [], removed: [], failed: [] };
  const bare = rows.filter((r) => !r.has_profile).map((r) => r.id);
  const halfMade = new Set<string>();
  if (bare.length > 0) {
    const { rows: managed } = await pools.auth.query<{ id: string }>(
      `DELETE FROM auth."user" WHERE id = ANY($1::uuid[]) AND lower(email) LIKE $2 RETURNING id`,
      [bare, `%@${MANAGED_EMAIL_DOMAIN}`],
    );
    for (const { id } of managed) {
      halfMade.add(id);
      result.removed.push(id);
    }
  }
  for (const { id } of rows) {
    if (halfMade.has(id)) continue;
    try {
      await ensureAccountAsSystem(pools, id);
      result.repaired.push(id);
    } catch (error) {
      // A user deleted meanwhile, say: the rest still get theirs.
      result.failed.push({ userId: id, error });
    }
  }
  return result;
}

/** A small LRU of user ids already ensured in this process. */
export class EnsuredUsers {
  readonly #max: number;
  readonly #ids = new Map<string, true>();

  constructor(max = 10_000) {
    this.#max = max;
  }

  has(userId: string): boolean {
    if (!this.#ids.has(userId)) return false;
    this.#ids.delete(userId);
    this.#ids.set(userId, true);
    return true;
  }

  add(userId: string): void {
    this.#ids.delete(userId);
    this.#ids.set(userId, true);
    if (this.#ids.size > this.#max) {
      const oldest = this.#ids.keys().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
  }

  get size(): number {
    return this.#ids.size;
  }
}

export type AccountEnsurer = {
  /** For createAuth({onUserCreated}). Managed accounts (`.invalid`) are skipped: task 21 makes
   * their profile first (kept.create_managed_profile), then their first sign-in (or the repair
   * job) ensures the rest. */
  onUserCreated: (
    user: { id: string; email: string },
    headers: Headers | undefined,
  ) => Promise<void>;
  /** For buildApp({onScope}): ensures once per process per user, then costs a Map lookup. */
  onScope: (req: FastifyRequest, scope: Scope, headers: Headers) => Promise<void>;
  cache: EnsuredUsers;
};

export function accountEnsurer(
  pools: Pick<Pools, 'app'>,
  cache = new EnsuredUsers(),
): AccountEnsurer {
  // Concurrent first requests of one user share one call.
  const inFlight = new Map<string, Promise<void>>();
  const ensureOnce = (userId: string, opts: EnsureOptions): Promise<void> => {
    let running = inFlight.get(userId);
    if (!running) {
      running = ensureAccount(pools, userId, opts)
        .then(() => cache.add(userId))
        .finally(() => inFlight.delete(userId));
      inFlight.set(userId, running);
    }
    return running;
  };
  return {
    cache,
    onUserCreated: async (user, headers) => {
      if (isUndeliverableEmail(user.email)) return;
      await ensureOnce(user.id, headers ? { headers } : {});
    },
    onScope: async (req, scope, headers) => {
      if (cache.has(scope.userId)) return;
      await ensureOnce(scope.userId, { headers, requestId: req.id });
    },
  };
}
