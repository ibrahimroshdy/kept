import type pg from 'pg';
import { isManagedEmail } from '../auth/managed.js';

// What an instance admin (task 23 routes, on kept_auth) and the operator's `kept admin` CLI (on
// kept_owner) do to an account in schema auth (D164, D165). Each is one statement or two, on any
// client with DML on schema auth; the caller audits and mails (D180).

type Queryable = pg.ClientBase | pg.Pool;

export type AuthUserRow = {
  id: string;
  email: string;
  username: string | null;
  name: string;
  banned: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
};

const USER_COLUMNS = `id, email, username, name, coalesce(banned, false) AS banned,
  coalesce(two_factor_enabled, false) AS "twoFactorEnabled", created_at AS "createdAt"`;

export async function findAuthUser(db: Queryable, userId: string): Promise<AuthUserRow | null> {
  const { rows } = await db.query<AuthUserRow>(
    `SELECT ${USER_COLUMNS} FROM auth."user" WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** By sign-in email or managed username, as an operator types it. */
export async function findAuthUserByLogin(
  db: Queryable,
  login: string,
): Promise<AuthUserRow | null> {
  const value = login.trim().toLowerCase();
  const { rows } = await db.query<AuthUserRow>(
    `SELECT ${USER_COLUMNS} FROM auth."user" WHERE lower(email) = $1 OR username = $1`,
    [value],
  );
  return rows[0] ?? null;
}

/** The address to tell about something done to the account, or null (a managed account's
 * synthetic address is never mailed, D47, D93). */
export function mailableAddress(user: Pick<AuthUserRow, 'email'>): string | null {
  return isManagedEmail(user.email) ? null : user.email;
}

export async function signOutEverywhere(db: Queryable, userId: string): Promise<void> {
  await db.query('DELETE FROM auth.session WHERE user_id = $1', [userId]);
}

/** Disabled: Better Auth's admin-plugin ban, which refuses every new session, and every
 * session there is now is ended. */
export async function disableUser(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `UPDATE auth."user" SET banned = true, ban_reason = 'Disabled by an instance admin',
            ban_expires = NULL, updated_at = now() WHERE id = $1`,
    [userId],
  );
  await signOutEverywhere(db, userId);
}

export async function enableUser(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `UPDATE auth."user" SET banned = false, ban_reason = NULL, ban_expires = NULL,
            updated_at = now() WHERE id = $1`,
    [userId],
  );
}

/** Two-factor reset (D165): the TOTP secret and backup codes go, and so does every session (a
 * second-factor change signs out, D176). Passkeys stay: they are a sign-in method, and the person
 * removes a lost one from their device list. */
export async function resetTwoFactor(db: Queryable, userId: string): Promise<void> {
  await db.query('DELETE FROM auth.two_factor WHERE user_id = $1', [userId]);
  await db.query(
    'UPDATE auth."user" SET two_factor_enabled = false, updated_at = now() WHERE id = $1',
    [userId],
  );
  await signOutEverywhere(db, userId);
}
