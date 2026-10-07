import { newId } from '@kept/shared';
import pg from 'pg';
import type { TestDb } from './db.js';

// Tenancy fixtures, written as kept_owner (the owner_all policy lets it see and write
// everything). Tests then read and write as kept_app or kept_system to check what those roles
// can reach.

/** A connected kept_owner client; the caller ends it. */
export async function ownerClient(db: TestDb): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: db.urls.owner });
  client.on('error', () => {});
  await client.connect();
  return client;
}

export async function asOwner<T>(db: TestDb, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await ownerClient(db);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Runs `fn` in a transaction as kept_owner and commits. */
export function ownerTx<T>(db: TestDb, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return asOwner(db, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

/** Inserts a Better Auth user row directly (tests only; the app goes through Better Auth). */
export async function insertUser(client: pg.ClientBase, label: string): Promise<string> {
  const id = newId();
  await client.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [
    id,
    label,
    `${label}-${id}@example.test`,
  ]);
  return id;
}

export type Tenant = {
  userId: string;
  accountId: string;
  locationId: string;
  unplacedId: string;
};

export type LocationOptions = {
  kind?: string;
  require2fa?: boolean;
  name?: string;
};

/** A location owned by `accountId`, with its owner membership and Unplaced area, inserted in
 * the order ensureAccount() uses (§7.14). Call inside a transaction: the owner check is
 * deferred to commit. */
export async function insertLocation(
  client: pg.ClientBase,
  owner: { userId: string; accountId: string },
  opts: LocationOptions = {},
): Promise<{ locationId: string; unplacedId: string }> {
  const locationId = newId();
  const unplacedId = newId();
  await client.query(
    `INSERT INTO public.locations (id, owner_account_id, kind, name, timezone, currency, require_2fa)
     VALUES ($1, $2, $3, $4, 'Africa/Cairo', 'EGP', $5)`,
    [
      locationId,
      owner.accountId,
      opts.kind ?? 'home',
      opts.name ?? 'Home',
      opts.require2fa ?? false,
    ],
  );
  await client.query(
    `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [locationId, owner.userId],
  );
  await client.query(
    `INSERT INTO public.places (id, location_id, name, is_unplaced) VALUES ($1, $2, 'Unplaced', true)`,
    [unplacedId, locationId],
  );
  return { locationId, unplacedId };
}

/** A user with a profile, an owner account and one location (a `home` by default, so other
 * members may join it). Committed as kept_owner. */
export function seedTenant(db: TestDb, label: string, opts: LocationOptions = {}): Promise<Tenant> {
  return ownerTx(db, async (client) => {
    const userId = await insertUser(client, label);
    await client.query('INSERT INTO public.user_profiles (user_id, display_name) VALUES ($1, $2)', [
      userId,
      label,
    ]);
    const accountId = newId();
    await client.query('INSERT INTO public.owner_accounts (id, user_id) VALUES ($1, $2)', [
      accountId,
      userId,
    ]);
    const loc = await insertLocation(client, { userId, accountId }, opts);
    return { userId, accountId, ...loc };
  });
}

/** Adds `userId` to a location with `role` (never `owner`), committed as kept_owner. */
export function addMember(
  db: TestDb,
  locationId: string,
  userId: string,
  role: 'admin' | 'member' | 'viewer',
  expiresAt: Date | null = null,
): Promise<void> {
  return ownerTx(db, async (client) => {
    await client.query(
      'INSERT INTO public.memberships (location_id, user_id, role, expires_at) VALUES ($1, $2, $3, $4)',
      [locationId, userId, role, expiresAt],
    );
  });
}

/** A bare user (auth row + profile, no account), committed as kept_owner. */
export function seedUser(db: TestDb, label: string): Promise<string> {
  return ownerTx(db, async (client) => {
    const userId = await insertUser(client, label);
    await client.query('INSERT INTO public.user_profiles (user_id, display_name) VALUES ($1, $2)', [
      userId,
      label,
    ]);
    return userId;
  });
}

/** The SQLSTATE and constraint of a rejected promise (or throws if it resolved). */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    type PgLike = { code?: string; constraint?: string; message: string; cause?: unknown };
    let e = err as PgLike;
    // Drizzle wraps driver errors in DrizzleQueryError, with the pg error as `cause`.
    if (e.code === undefined && e.cause && typeof e.cause === 'object') e = e.cause as PgLike;
    return { code: e.code ?? '', constraint: e.constraint, message: e.message };
  }
  throw new Error('expected the statement to fail, and it succeeded');
}

export type InviteOptions = {
  role?: 'admin' | 'member' | 'viewer';
  email?: string | null;
  /** Default: 7 days from now. */
  expiresAt?: Date;
  membershipExpiresAt?: Date | null;
};

/** An invite to `locationId` from `createdBy`, committed as kept_owner. Returns its token hash
 * (what kept.accept_invite() and kept.invite_preview() take). */
export function insertInvite(
  db: TestDb,
  locationId: string,
  createdBy: string | null,
  opts: InviteOptions = {},
): Promise<string> {
  const tokenHash = `hash-${newId()}`;
  return ownerTx(db, async (client) => {
    await client.query(
      `INSERT INTO public.invites
         (location_id, role, membership_expires_at, email, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        locationId,
        opts.role ?? 'member',
        opts.membershipExpiresAt ?? null,
        opts.email ?? null,
        tokenHash,
        opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
        createdBy,
      ],
    );
    return tokenHash;
  });
}

/** The auth email of `userId`, marked verified (or not), as kept_owner. */
export function userEmail(db: TestDb, userId: string, verified = true): Promise<string> {
  return ownerTx(db, async (client) => {
    const { rows } = await client.query<{ email: string }>(
      'UPDATE auth."user" SET email_verified = $2 WHERE id = $1 RETURNING email',
      [userId, verified],
    );
    return rows[0]?.email as string;
  });
}
