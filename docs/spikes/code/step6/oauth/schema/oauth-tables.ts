import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authSchema, session, user } from './kept-auth-base.js';

// The tables `jwt()`, `mcp()` (= `oauthProvider`) and `cimd()` add, from the Better Auth CLI's
// output in ../generated/auth-schema.cli.ts (`auth@1.7.6 generate --adapter drizzle
// --dialect postgresql`), adjusted the way S1 adjusted the base tables:
// - `pgSchema('auth')` instead of `pgTable` (the CLI can't take `schemaName` here: see
//   auth-cli.config.ts);
// - every timestamp `timestamptz`; uuid ids default to Postgres 18's `uuidv7()`;
// - `oauth_client_assertion.id` is TEXT: oauth-provider writes it with `forceAllowId: true` as a
//   base64url digest of the assertion's `jti` (authorize-*.mjs, the private_key_jwt replay guard),
//   the same trap S2 found for `auth.verification.id`.
// `cimd()` adds no table of its own: it stores discovered clients in `oauth_client`
// (`client_discovery_id = 'cimd'`, `client_id` = the metadata URL).

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tstz = (name: string) => timestamp(name, { withTimezone: true });

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
    uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(table.clientId, table.resourceId),
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

/** The new models, keyed by Better Auth model name (merged with Kept's betterAuthTables). */
export const oauthTables = {
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
};
