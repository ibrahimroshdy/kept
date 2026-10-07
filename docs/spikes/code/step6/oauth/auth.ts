/**
 * Spike S6.2: a COPY of apps/server/src/auth/auth.ts (createAuth) with `jwt()`, `mcp()` and
 * `cimd()` added. Throwaway; never imported by apps/.
 *
 * Kept as in the original: basePath /api/v1/auth, the drizzle adapter on a kept_auth pool with
 * the tables in schema `auth`, UUIDv7 ids, hashed verification identifiers, the session
 * lifetimes, database rate limiting, DISABLED_AUTH_PATHS, telemetry off, twoFactor, magicLink,
 * username, admin.
 * Left out, because they import Kept modules that would load a second copy of better-auth (the
 * spike has its own node_modules): the kept-security plugin (the MFA gate, the sign-in delays),
 * passkey, the mail senders and onUserCreated. What that means for T12 is in the spike report.
 */
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, magicLink, twoFactor, username } from 'better-auth/plugins';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import { betterAuthTables } from './schema/kept-auth-base.js';
import { oauthTables } from './schema/oauth-tables.js';

export const AUTH_BASE_PATH = '/api/v1/auth';

/** The paths the original disables (auth.ts DISABLED_AUTH_PATHS), abridged to the non-admin ones
 * plus the admin plugin's; the spike adds nothing here, so the report can say what `jwt()` exposes. */
export const DISABLED_AUTH_PATHS = [
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
  '/admin/list-user-sessions',
  '/magic-link/verify',
  '/change-email',
  '/list-sessions',
  '/revoke-session',
  '/sign-up/email',
  '/is-username-available',
];

export async function hashVerificationIdentifier(identifier: string): Promise<string> {
  const colon = identifier.indexOf(':');
  const prefix = colon >= 0 ? identifier.slice(0, colon + 1) : '';
  return prefix + createHash('sha256').update(identifier).digest('base64url');
}

export type SpikeAuthDeps = {
  /** A pool logged in as kept_auth. */
  pool: pg.Pool;
  publicUrl: string;
  secret: string;
  /** The CIMD transport under test (Kept's guardedFetch, or @better-auth/cimd/node's). */
  fetchClientMetadataResource: ClientMetadataResourceFetch;
  /** Q8: DCR stays off unless a run turns it on (serve.ts SPIKE_ALLOW_DCR=1, to observe a
   * DCR-only client; the decision itself is the maintainer's). */
  allowDynamicClientRegistration?: boolean;
  allowUnauthenticatedClientRegistration?: boolean;
};

export function createSpikeAuth(deps: SpikeAuthDeps) {
  const { pool } = deps;
  const publicUrl = new URL(deps.publicUrl);
  const https = publicUrl.protocol === 'https:';
  return betterAuth({
    appName: 'Kept',
    baseURL: deps.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: deps.secret,
    database: drizzleAdapter(drizzle(pool, { schema: { ...betterAuthTables, ...oauthTables } }), {
      provider: 'pg',
      schema: { ...betterAuthTables, ...oauthTables },
      transaction: true,
    }),
    emailAndPassword: { enabled: true },
    verification: { storeIdentifier: { hash: hashVerificationIdentifier } },
    session: https
      ? { expiresIn: 30 * 86_400, updateAge: 86_400, freshAge: 600 }
      : { expiresIn: 12 * 3_600, disableSessionRefresh: true, freshAge: 600 },
    advanced: {
      useSecureCookies: https,
      database: { generateId: () => uuidv7() },
    },
    rateLimit: { enabled: false, storage: 'database' },
    disabledPaths: DISABLED_AUTH_PATHS,
    telemetry: { enabled: false },
    plugins: [
      twoFactor({ issuer: 'Kept' }),
      magicLink({ disableSignUp: true, storeToken: 'hashed', sendMagicLink: async () => {} }),
      username(),
      admin(),
      // ---- S6.2 ----
      jwt(),
      mcp({
        loginPage: '/signin',
        consentPage: '/oauth/consent',
        resource: `${deps.publicUrl}/mcp`,
        scopes: ['kept:read', 'kept:write'],
        allowDynamicClientRegistration: deps.allowDynamicClientRegistration ?? false,
        allowUnauthenticatedClientRegistration: deps.allowUnauthenticatedClientRegistration ?? false,
        accessTokenExpiresIn: 3600,
      }),
      cimd({
        fetchClientMetadataResource: deps.fetchClientMetadataResource,
        metadataProfile: 'mcp-2026-07-28',
      }),
    ],
  });
}

export type SpikeAuth = ReturnType<typeof createSpikeAuth>;
