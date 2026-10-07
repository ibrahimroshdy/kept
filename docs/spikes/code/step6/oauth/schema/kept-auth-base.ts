// COPY of apps/server/src/db/schema/auth.ts at the spike's date (S6.2); the base tables Kept's
// migrations already create. Not edited, so the spike's drizzle adapter sees Kept's real columns.
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Better Auth's tables (§7.1, §7.10, spike S1). Generated with `pnpm dlx auth@1.7.6 generate`
// (the Better Auth CLI; the package moved from `@better-auth/cli` to `auth`) for the plugins
// twoFactor, passkey, magicLink, username and admin, then adjusted for Kept:
// - every timestamp is `timestamptz` (the generator emits `timestamp`);
// - ids default to Postgres 18's `uuidv7()`. Better Auth also issues UUIDv7 ids itself
//   (`advanced.database.generateId`, see auth/auth.ts); the default only covers rows it never
//   writes directly.
// The tables live in schema `auth`, owned by kept_owner; kept_auth gets DML through the default
// privileges in migration 0000. Nothing else may read them (§7.1), except where a later task
// grants one table explicitly.
export const authSchema = pgSchema('auth');

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const user = authSchema.table('user', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: tstz('created_at').defaultNow().notNull(),
  updatedAt: tstz('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: tstz('ban_expires'),
});

export const session = authSchema.table(
  'session',
  {
    id: id(),
    expiresAt: tstz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = authSchema.table(
  'account',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
);

export const verification = authSchema.table(
  'verification',
  {
    // Text, not uuid: reserveVerificationValue() (used by magic-link verify for unverified
    // emails, and by other single-use flows) writes a deterministic id, the base64url SHA-256 of
    // the identifier. Found in spike S2.
    id: text('id').primaryKey().default(sql`uuidv7()::text`),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const twoFactor = authSchema.table(
  'two_factor',
  {
    id: id(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: tstz('locked_until'),
  },
  (table) => [
    index('twoFactor_secret_idx').on(table.secret),
    index('twoFactor_userId_idx').on(table.userId),
  ],
);

export const passkey = authSchema.table(
  'passkey',
  {
    id: id(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: tstz('created_at'),
    aaguid: text('aaguid'),
  },
  (table) => [
    index('passkey_userId_idx').on(table.userId),
    index('passkey_credentialID_idx').on(table.credentialID),
  ],
);

// Better Auth's `rateLimit: { storage: 'database' }` store: shared by every replica (V32).
export const rateLimit = authSchema.table('rate_limit', {
  id: id(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// ---- Kept's own auth-side tables (spike S2). Written by kept_auth from Better Auth hooks. ----

/** A session that has passed a second factor (TOTP, backup code, OTP, or a passkey with user
 * verification). Absence means "not satisfied": the gate fails closed for any sign-in path
 * Better Auth adds later (D176, §7.14). */
export const sessionMfa = authSchema.table('session_mfa', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => session.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  satisfiedAt: tstz('satisfied_at').defaultNow().notNull(),
});

/** Failed credential attempts keyed on account + IP (D172, engineering spec §3.2): 20 per hour
 * with progressive delays, so nobody can lock someone else out. `key` is a SHA-256 of the
 * normalised account identifier and the client IP, never the raw email. */
export const signInFailures = authSchema.table('sign_in_failures', {
  key: text('key').primaryKey(),
  windowStart: tstz('window_start').notNull(),
  count: integer('count').notNull(),
  lastFailureAt: tstz('last_failure_at').notNull(),
});

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  twoFactors: many(twoFactor),
  passkeys: many(passkey),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, { fields: [twoFactor.userId], references: [user.id] }),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, { fields: [passkey.userId], references: [user.id] }),
}));

/** The tables Better Auth's Drizzle adapter reads, keyed by Better Auth model name. */
export const betterAuthTables = {
  user,
  session,
  account,
  verification,
  twoFactor,
  passkey,
  rateLimit,
};
