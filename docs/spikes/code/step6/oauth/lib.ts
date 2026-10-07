/**
 * Shared by run.ts (the local flow) and serve.ts (the maintainer's real-client check): the scratch
 * database and the Kept stand-in server (Better Auth at /api/v1/auth/*, root /.well-known/*
 * mounts, POST /mcp behind requireMcpAuth or verifyBearerToken).
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { requireMcpAuth } from '@better-auth/mcp';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import pg from 'pg';
import * as z from 'zod';
import { runMigrations } from '../../../../../apps/server/src/db/migrate.js';
import type { SpikeAuth } from './auth.js';
import { describe } from './cimd-fetch.js';

export const here = path.dirname(new URL(import.meta.url).pathname);
export const DB = 'kept_spike6_oauth';
const SUPER = process.env.SPIKE_PG ?? '';
if (!SUPER) throw new Error('set SPIKE_PG (the dev container superuser URL, no database)');
const pgBase = new URL(SUPER);
export const roleUrl = (role: string) => {
  const u = new URL(`postgres://localhost/${DB}`);
  u.hostname = pgBase.hostname;
  u.port = pgBase.port;
  u.username = `kept_${role}`;
  u.password = (process.env.SPIKE_ROLE_PASSWORD_PATTERN ?? '{role}').replace('{role}', `kept_${role}`);
  return u.toString();
};
const superUrl = (db: string) => {
  const u = new URL(SUPER);
  u.pathname = `/${db}`;
  return u.toString();
};


// -------------------------------------------------------------------------------------------
// Database
// -------------------------------------------------------------------------------------------

export async function asSuper<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: superUrl(db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createDatabase(say: (key: string, value: unknown) => void): Promise<void> {
  await asSuper('postgres', async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.query(`CREATE DATABASE ${DB} OWNER kept_owner`);
  });
  const t0 = performance.now();
  await runMigrations(roleUrl('owner'));
  const migrateMs = performance.now() - t0;
  // The CLI-derived tables, as kept_owner (DDL is the owner's; kept_auth only gets DML).
  const sql = readFileSync(path.join(here, 'generated/oauth-tables.sql'), 'utf8');
  const owner = new pg.Client({ connectionString: roleUrl('owner') });
  await owner.connect();
  try {
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await owner.query(stmt);
    }
    const { rows } = await owner.query<{
      table: string;
      owner: string;
      auth_dml: boolean;
      app_select: boolean;
      system_select: boolean;
    }>(
      `SELECT c.relname AS table, pg_get_userbyid(c.relowner) AS owner,
              has_table_privilege('kept_auth', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS auth_dml,
              has_table_privilege('kept_app', c.oid, 'SELECT') AS app_select,
              has_table_privilege('kept_system', c.oid, 'SELECT') AS system_select
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth' AND c.relkind = 'r'
          AND (c.relname LIKE 'oauth%' OR c.relname = 'jwks')
        ORDER BY 1`,
    );
    say('db', { database: DB, migrateMs: Math.round(migrateMs), newTables: rows });
  } finally {
    await owner.end();
  }
}

export async function dropDatabase(): Promise<void> {
  await asSuper('postgres', async (c) => {
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DB],
    );
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
  });
}

// -------------------------------------------------------------------------------------------
// The Kept stand-in: Better Auth + /mcp
// -------------------------------------------------------------------------------------------

export type ServerState = {
  auth: SpikeAuth;
  publicUrl: string;
  /** Route root /.well-known/* at all (and how). */
  wellKnown: 'none' | 'mounted' | 'prm-only';
  /** Which verifier guards POST /mcp. */
  mcpGuard: 'requireMcpAuth' | 'verifyBearerToken';
  requests: string[];
  toolCalls: unknown[];
  jwtClaims: unknown[];
};

export function mcpFactory(state: ServerState) {
  return ({ authInfo, era }: { authInfo?: AuthInfo; era: string }) => {
    const server = new McpServer({ name: 'kept-spike', version: '0.0.0' });
    server.registerTool(
      'whoami',
      { description: 'Who the token belongs to.', inputSchema: z.object({}) },
      async () => {
        const seen = {
          era,
          clientId: authInfo?.clientId,
          scopes: authInfo?.scopes,
          resource: authInfo?.resource?.toString(),
          sub: (authInfo?.extra as { sub?: string } | undefined)?.sub,
        };
        state.toolCalls.push(seen);
        return { content: [{ type: 'text', text: JSON.stringify(seen) }] };
      },
    );
    return server;
  };
}

export type StartKeptOptions = {
  port: number;
  /** Defaults to http://127.0.0.1:<port>. The maintainer's run passes the tunnel's https URL. */
  publicUrl?: string;
  /** The loginPage and consentPage (the SPA's in Kept); a placeholder when absent. */
  pages?: (url: URL) => Response | undefined;
  /** Sees every request after it is answered (serve.ts records what real clients do). */
  observe?: (req: { method: string; url: URL; headers: Headers; body: Buffer }, status: number) => void;
};

export function startKept(state: Omit<ServerState, 'publicUrl'>, opts: StartKeptOptions): Promise<http.Server> {
  const { port } = opts;
  const s = state as ServerState;
  s.publicUrl = opts.publicUrl ?? `http://127.0.0.1:${port}`;
  const resource = `${s.publicUrl}/mcp`;
  const issuer = `${s.publicUrl}/api/v1/auth`;
  const mcpHandler = createMcpHandler(mcpFactory(s) as never, { legacy: 'stateless', responseMode: 'json' });
  const authServerMetadata = oauthProviderAuthServerMetadata(s.auth as never);

  // Path B: the MCP SDK's verifyBearerToken with a verifier on Better Auth's own JWKS, read
  // in-process (auth.api.getJwks), so no HTTP round trip to /jwks.
  const jwksCacheKey = {};
  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      try {
        const claims = await verifyJwsAccessToken(token, {
          jwksFetch: async () => (await s.auth.api.getJwks()) as never,
          jwksCacheKey,
          verifyOptions: { issuer, audience: resource },
        });
        s.jwtClaims.push({ path: 'verifyBearerToken', claims });
        return {
          token,
          clientId: String(claims.azp ?? claims.client_id ?? ''),
          scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
          expiresAt: claims.exp,
          resource: new URL(resource),
          extra: { sub: claims.sub },
        };
      } catch (err) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, describe(err));
      }
    },
  };
  const prmUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));

  const guardA = requireMcpAuth(
    s.auth as never,
    async (req, claims) => {
      s.jwtClaims.push({ path: 'requireMcpAuth', claims });
      const authInfo: AuthInfo = {
        token: (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''),
        clientId: String(claims.azp ?? claims.client_id ?? ''),
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
        expiresAt: claims.exp,
        resource: new URL(resource),
        extra: { sub: claims.sub },
      };
      return mcpHandler.fetch(req, { authInfo });
    },
    { resource },
  );

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', s.publicUrl);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else if (v !== undefined) headers.set(k, v);
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    let response: Response;
    try {
      if (url.pathname.startsWith('/api/v1/auth/')) {
        response = await s.auth.handler(request);
      } else if (url.pathname.startsWith('/.well-known/')) {
        if (s.wellKnown === 'none') response = new Response('not mounted', { status: 404 });
        else if (url.pathname.startsWith('/.well-known/oauth-authorization-server'))
          response =
            s.wellKnown === 'prm-only'
              ? new Response('not mounted', { status: 404 })
              : await authServerMetadata(request);
        // The mcp plugin's onRequest answers /.well-known/oauth-protected-resource[/mcp] when the
        // request reaches auth.handler, whatever the path: forward it unchanged.
        else response = await s.auth.handler(request);
      } else if (url.pathname === '/mcp') {
        if (s.mcpGuard === 'requireMcpAuth') response = await guardA(request);
        else {
          try {
            const authInfo = await verifyBearerToken(req.headers.authorization, {
              verifier,
              resourceMetadataUrl: prmUrl,
            });
            response = await mcpHandler.fetch(request, { authInfo });
          } catch (err) {
            response = bearerAuthChallengeResponse(err, { resourceMetadataUrl: prmUrl });
          }
        }
      } else if (url.pathname === '/signin' || url.pathname === '/oauth/consent') {
        response = opts.pages?.(url) ?? new Response('the SPA page would render here', { status: 200 });
      } else response = new Response('not found', { status: 404 });
    } catch (err) {
      response = new Response(`server error: ${describe(err)}`, { status: 500 });
    }
    s.requests.push(`${req.method} ${url.pathname}${url.search ? '?…' : ''} -> ${response.status}`);
    try {
      opts.observe?.({ method: req.method ?? 'GET', url, headers, body }, response.status);
    } catch {}
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of response.headers) {
      if (k === 'set-cookie') continue;
      out[k] = v;
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
