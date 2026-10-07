/**
 * Config for the Better Auth CLI only (`npm run generate`): the three new plugins on the same
 * adapter options S1 used, so the CLI emits `pgSchema('auth')` tables with uuid ids. Never run as
 * a server. The runtime copy of Kept's auth.ts is ./auth.ts.
 */
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';

export const auth = betterAuth({
  baseURL: 'http://127.0.0.1:3000',
  basePath: '/api/v1/auth',
  // No `database`: oauth-provider's init seeds the MCP resource row (seedResources), which
  // crashes on S1's `drizzleAdapter({}, …)` stub. The CLI is run with `--adapter drizzle
  // --dialect postgresql` instead, so it emits pgTable(); schema `auth` is applied by hand.
  advanced: { database: { generateId: 'uuid' } },
  plugins: [
    jwt(),
    mcp({
      loginPage: '/signin',
      consentPage: '/oauth/consent',
      resource: 'http://127.0.0.1:3000/mcp',
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
  ],
});
