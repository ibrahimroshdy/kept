import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { audited } from '../audit/audited.js';
import { hashVerificationIdentifier, linkUrl } from '../auth/auth.js';
import { isManagedEmail } from '../auth/managed.js';
import * as schema from '../db/schema/index.js';
import type { Tx } from '../db/scope.js';
import type { AdminAction, Mail, Mailer } from '../mail/mailer.js';
import {
  formatSetupCode,
  generateSetupCode,
  hashSetupCode,
  SETUP_ALL_KEY,
  SETUP_CODE_KEY,
  SETUP_LOCK,
  setupNeeded,
} from '../setup/setup-code.js';
import {
  type AuthUserRow,
  disableUser,
  enableUser,
  findAuthUser,
  findAuthUserByLogin,
  mailableAddress,
  signOutEverywhere,
} from './account-ops.js';

// `kept admin` (D165, D180, D190): the operator's way back in when there is no SMTP or the only
// instance admin is locked out. It runs on the server as kept_owner (never a serving login), one
// transaction per command, and audits as `system`. What it does to someone's account is mailed
// to them (D180) once the transaction commits.

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** A reset link made here lives as long as Better Auth's own (one hour). */
export const CLI_RESET_TTL_SECONDS = 3600;

type Done<T> = { result: T; mail: Mail[] };

/** Runs `fn` in one kept_owner transaction, then sends its mail. */
export async function asOwner<T>(
  ownerUrl: string,
  mailer: Mailer,
  fn: (client: pg.ClientBase, tx: Tx) => Promise<Done<T>>,
): Promise<T> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'kept-admin' });
  // A backend ended under it emits 'error'; unhandled, that ends the process instead of failing
  // the command's next statement.
  client.on('error', () => {});
  await client.connect();
  let done: Done<T>;
  try {
    await client.query('BEGIN');
    try {
      done = await fn(client, drizzle(client, { schema }));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end();
  }
  for (const mail of done.mail) {
    await mailer.send(mail).catch(() => {});
  }
  return done.result;
}

function auditSystem(
  tx: Tx,
  action: string,
  entity: { type: string; id: string | null },
  extra: {
    locationId?: string;
    ownerAccountId?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  } = {},
) {
  return audited(tx, {
    locationId: extra.locationId ?? null,
    ownerAccountId: extra.ownerAccountId ?? null,
    actor: { type: 'system', id: null },
    action,
    entity,
    ...(extra.before ? { before: extra.before } : {}),
    ...(extra.after ? { after: extra.after } : {}),
  });
}

const told = (user: AuthUserRow, action: AdminAction, locationName?: string): Mail[] => {
  const to = mailableAddress(user);
  return to
    ? [{ kind: 'admin-action', to, action, ...(locationName ? { locationName } : {}) }]
    : [];
};

async function userByLogin(client: pg.ClientBase, login: string): Promise<AuthUserRow> {
  const user = await findAuthUserByLogin(client, login);
  if (!user) throw new CliError(`no account signs in as ${login}`);
  return user;
}

export type ResetIssued = {
  login: string;
  code: string;
  /** The page that takes it, when KEPT_PUBLIC_URL is known. */
  url: string | null;
  expiresAt: Date;
};

/**
 * `kept admin reset-password <email|username>`: a one-time code for Better Auth's reset (the web
 * page /auth/reset takes it from its #fragment), valid an hour, for any account, managed or not.
 * Earlier reset links die, every session is signed out now (D164), and the person is told (D180).
 * The operator hands the code over; nobody learns the new password.
 */
export function resetPassword(
  ownerUrl: string,
  mailer: Mailer,
  login: string,
  publicUrl?: string,
): Promise<ResetIssued> {
  return asOwner(ownerUrl, mailer, async (client, tx) => {
    const user = await userByLogin(client, login);
    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CLI_RESET_TTL_SECONDS * 1000);
    await client.query(
      `DELETE FROM auth.verification WHERE identifier LIKE 'reset-password:%' AND value = $1`,
      [user.id],
    );
    await client.query(
      `INSERT INTO auth.verification (identifier, value, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())`,
      [await hashVerificationIdentifier(`reset-password:${code}`), user.id, expiresAt],
    );
    await signOutEverywhere(client, user.id);
    await auditSystem(tx, 'admin.cli_reset_password', { type: 'user', id: user.id });
    return {
      result: {
        login: isManagedEmail(user.email) ? (user.username ?? user.id) : user.email,
        code,
        url: publicUrl ? linkUrl(publicUrl, '/auth/reset', code) : null,
        expiresAt,
      },
      mail: told(user, 'password-reset-issued'),
    };
  });
}

/**
 * `kept admin setup-code`: a new setup code while setup is still pending (the first one's log
 * line was lost), replacing the old; also lifts the instance-wide lockout on wrong codes. Once
 * an instance admin exists there is nothing to set up: reset-password is the way back in.
 */
export function reissueSetupCode(ownerUrl: string, mailer: Mailer): Promise<string> {
  return asOwner(ownerUrl, mailer, async (client, tx) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
    if (!(await setupNeeded(client))) {
      throw new CliError(
        'Kept is already set up; to get an admin back in, use `kept admin reset-password`',
      );
    }
    const code = generateSetupCode();
    await client.query(
      `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [SETUP_CODE_KEY, JSON.stringify(hashSetupCode(code))],
    );
    await client.query('DELETE FROM auth.sign_in_failures WHERE key = $1', [SETUP_ALL_KEY]);
    await auditSystem(tx, 'instance.setup_code_reissue', { type: 'instance_settings', id: null });
    return { result: formatSetupCode(code), mail: [] };
  });
}

/** `kept admin disable-user <email|username>`: no new sessions, every current one ended. */
export function disableUserByLogin(
  ownerUrl: string,
  mailer: Mailer,
  login: string,
): Promise<AuthUserRow> {
  return asOwner(ownerUrl, mailer, async (client, tx) => {
    const user = await userByLogin(client, login);
    await disableUser(client, user.id);
    await auditSystem(tx, 'admin.cli_user_disable', { type: 'user', id: user.id });
    return { result: user, mail: told(user, 'disabled') };
  });
}

/** `kept admin enable-user <email|username>`: undoes disable-user (sessions stay ended). */
export function enableUserByLogin(
  ownerUrl: string,
  mailer: Mailer,
  login: string,
): Promise<AuthUserRow> {
  return asOwner(ownerUrl, mailer, async (client, tx) => {
    const user = await userByLogin(client, login);
    await enableUser(client, user.id);
    await auditSystem(tx, 'admin.cli_user_enable', { type: 'user', id: user.id });
    return { result: user, mail: told(user, 'enabled') };
  });
}

export type Transferred = { locationId: string; name: string; from: string; to: string };

/**
 * `kept admin transfer-ownership <locationId> <toUserId>` (D165): when a location's owner is gone
 * (or can't be reached), the operator moves it to another person. The location moves to the new
 * owner's account (made if they have none yet), they become its owner member, and the previous
 * owner, if their account still exists, stays on as an admin, for the new owner to keep or
 * remove. A Personal location never changes hands. Audited on the location; both people told.
 */
export function transferOwnership(
  ownerUrl: string,
  mailer: Mailer,
  locationId: string,
  toUserId: string,
): Promise<Transferred> {
  return asOwner(ownerUrl, mailer, async (client, tx) => {
    const { rows } = await client.query<{
      name: string;
      kind: string;
      deleted_at: Date | null;
      owner_user: string;
    }>(
      `SELECT l.name, l.kind, l.deleted_at, oa.user_id AS owner_user
         FROM public.locations l JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
        WHERE l.id = $1 FOR UPDATE OF l`,
      [locationId],
    );
    const loc = rows[0];
    if (!loc) throw new CliError(`no location ${locationId}`);
    if (loc.kind === 'personal') throw new CliError("a Personal location can't change owner");
    if (loc.deleted_at) throw new CliError('the location is deleted; restore it first');
    if (loc.owner_user === toUserId) throw new CliError('they already own it');
    const to = await findAuthUser(client, toUserId);
    if (!to) throw new CliError(`no user ${toUserId}`);
    if (isManagedEmail(to.email)) throw new CliError("a managed account can't own a location");

    // Their owner account, made as ensureAccount would if they have none (as that user).
    await client.query("SELECT set_config('app.user_id', $1, true)", [toUserId]);
    const ensured = await client.query<{ owner_account_id: string }>(
      'SELECT owner_account_id FROM kept.ensure_account(NULL, NULL, NULL)',
    );
    await client.query("SELECT set_config('app.user_id', '', true)");
    const accountId = ensured.rows[0]?.owner_account_id;
    if (!accountId) throw new Error('ensure_account returned no account');

    await client.query(
      `UPDATE public.locations
          SET owner_account_id = $2,
              successor_user_id = CASE WHEN successor_user_id = $3 THEN NULL ELSE successor_user_id END
        WHERE id = $1`,
      [locationId, accountId, toUserId],
    );
    await client.query(
      `UPDATE public.memberships SET role = 'admin'
        WHERE location_id = $1 AND user_id = $2 AND role = 'owner'`,
      [locationId, loc.owner_user],
    );
    await client.query(
      `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (location_id, user_id) DO UPDATE SET role = 'owner', expires_at = NULL`,
      [locationId, toUserId],
    );
    await auditSystem(
      tx,
      'location.transfer_ownership',
      { type: 'location', id: locationId },
      {
        locationId,
        ownerAccountId: accountId,
        before: { owner_user_id: loc.owner_user },
        after: { owner_user_id: toUserId },
      },
    );
    const from = await findAuthUser(client, loc.owner_user);
    return {
      result: { locationId, name: loc.name, from: loc.owner_user, to: toUserId },
      mail: [
        ...told(to, 'location-ownership-received', loc.name),
        ...(from ? told(from, 'location-ownership-moved', loc.name) : []),
      ],
    };
  });
}
