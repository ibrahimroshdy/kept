import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
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

// Step 6 (T7; spike S6.2, docs/spikes/2026-09-30-step6-oauth-cimd.md): the tables `jwt()`,
// `oauthProvider()`/`mcp()` and `cimd()` add, from the Better Auth CLI's output for those plugins
// (`auth@1.7.6 generate --adapter drizzle --dialect postgresql`, no `database` in its config:
// S1's stub adapter crashes on oauth-provider's startup seeding), adjusted as above. `cimd()` adds
// no table: a discovered client is an `oauth_client` row (`client_discovery_id = 'cimd'`,
// `client_id` = its metadata URL). `oauth_client_assertion.id` is text: oauth-provider writes it
// with `forceAllowId: true` as a digest of the assertion's `jti`. Generic OIDC (S6.7) adds none:
// its link is an `account` row. Kept's grant of scope and locations is public.api_tokens (kind
// 'oauth'), not these.
export const jwks = authSchema.table('jwks', {
  id: id(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: tstz('created_at').notNull(),
  expiresAt: tstz('expires_at'),
  alg: text('alg'),
  crv: text('crv'),
});

export const oauthClient = authSchema.table(
  'oauth_client',
  {
    id: id(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at'),
    updatedAt: tstz('updated_at'),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (table) => [index('oauthClient_userId_idx').on(table.userId)],
);

export const oauthResource = authSchema.table('oauth_resource', {
  id: id(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb('metadata'),
});

export const oauthClientResource = authSchema.table(
  'oauth_client_resource',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: tstz('created_at'),
  },
  (table) => [
    uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(
      table.clientId,
      table.resourceId,
    ),
    index('oauthClientResource_clientId_idx').on(table.clientId),
    index('oauthClientResource_resourceId_idx').on(table.resourceId),
  ],
);

export const oauthRefreshToken = authSchema.table(
  'oauth_refresh_token',
  {
    id: id(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull(),
    revoked: tstz('revoked'),
    rotatedAt: tstz('rotated_at'),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: tstz('rotation_replay_expires_at'),
    authTime: tstz('auth_time'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('oauthRefreshToken_clientId_idx').on(table.clientId),
    index('oauthRefreshToken_sessionId_idx').on(table.sessionId),
    index('oauthRefreshToken_userId_idx').on(table.userId),
    index('oauthRefreshToken_authorizationCodeId_idx').on(table.authorizationCodeId),
  ],
);

export const oauthAccessToken = authSchema.table(
  'oauth_access_token',
  {
    id: id(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: uuid('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull(),
    revoked: tstz('revoked'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('oauthAccessToken_clientId_idx').on(table.clientId),
    index('oauthAccessToken_sessionId_idx').on(table.sessionId),
    index('oauthAccessToken_userId_idx').on(table.userId),
    index('oauthAccessToken_authorizationCodeId_idx').on(table.authorizationCodeId),
    index('oauthAccessToken_refreshId_idx').on(table.refreshId),
  ],
);

export const oauthConsent = authSchema.table(
  'oauth_consent',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (table) => [
    index('oauthConsent_clientId_idx').on(table.clientId),
    index('oauthConsent_userId_idx').on(table.userId),
  ],
);

export const oauthClientAssertion = authSchema.table('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: tstz('expires_at').notNull(),
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
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
};
