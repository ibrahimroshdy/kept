/**
 * Spike S6.2 (V15), local half. Run from this directory:
 *
 *   SPIKE_PG=postgres://<superuser>:<password>@localhost:5452 npx tsx run.ts
 *
 * SPIKE_PG is the dev container's superuser URL without a database (the bench's `superUrl`);
 * role logins are the dev compose values (docker/initdb/01-roles.sql), built from
 * SPIKE_ROLE_PASSWORD_PATTERN (default: the role name). Nothing secret is written to disk:
 * the TLS key for the fixture is generated into a temp directory and deleted at the end.
 *
 * What it does (every result is printed as JSON and written to ./results.json):
 * 1. Creates kept_spike6_oauth OWNED BY kept_owner, runs Kept's migrations, applies
 *    generated/oauth-tables.sql as kept_owner, checks kept_auth's privileges; drops it at the end.
 * 2. Starts a self-signed HTTPS fixture on 127.0.0.1 serving a Client ID Metadata Document at
 *    https://127.0.0.1.nip.io:<port>/oauth/client.json (a public DNS name that resolves to
 *    127.0.0.1), trusted through tls.setDefaultCACertificates.
 * 3. Starts the "Kept" server (node:http): Better Auth at /api/v1/auth/*, optional root
 *    /.well-known/* mounts, POST /mcp behind requireMcpAuth or verifyBearerToken.
 * 4. Probes the discovery documents with and without root mounts.
 * 5. Runs the official MCP client (2.2.0) with an OAuthClientProvider that has clientMetadataUrl:
 *    discovery from the 401, authorization code + PKCE, consent, token, tools/call.
 * 6. Negative checks: the guard refusing a loopback-resolving and a private-resolving client id,
 *    a redirect, Better Auth's own node transport on the same URL, the jwt plugin's session JWT
 *    at /mcp, a flow without `resource`, DCR while off, a bad token.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fetchClientMetadataResource as betterAuthNodeFetch } from '@better-auth/cimd/node';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import {
  buildDiscoveryUrls,
  Client,
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import pg from 'pg';
import { createSpikeAuth, type SpikeAuth } from './auth.js';
import { createGuardedCimdFetch, describe, type FetchLogEntry, type Resolve } from './cimd-fetch.js';
import { createDatabase, dropDatabase, here, roleUrl, type ServerState, startKept } from './lib.js';

const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const say = (key: string, value: unknown) => {
  results[key] = value;
  console.log(`\n## ${key}\n${JSON.stringify(value, null, 2)}`);
};

// -------------------------------------------------------------------------------------------
// The HTTPS fixture: the client's metadata document
// -------------------------------------------------------------------------------------------

/** Reads a JWT's parts without verifying (display only; jose is not a declared dependency). */
const jwtPart = (jwt: string, i: 0 | 1) =>
  JSON.parse(Buffer.from(jwt.split('.')[i] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
const decodeJwt = (jwt: string) => jwtPart(jwt, 1);
const decodeProtectedHeader = (jwt: string) => jwtPart(jwt, 0);

const FIXTURE_HOST = '127.0.0.1.nip.io';
const NAVIGATE = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };

type Fixture = { origin: string; close: () => Promise<void>; hits: string[]; tmp: string };

async function startFixture(redirectUri: string): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kept-s62-'));
  const key = path.join(tmp, 'key.pem');
  const cert = path.join(tmp, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${FIXTURE_HOST}`,
    '-addext', `subjectAltName=DNS:${FIXTURE_HOST}`,
  ], { stdio: 'ignore' });
  // Trust the fixture's certificate process-wide (Node 24's tls.setDefaultCACertificates); undici's
  // TLS connect, which guardedFetch uses, reads the default store. No verification is turned off.
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(cert, 'utf8')]);
  const hits: string[] = [];
  let origin = '';
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
      if (req.url === '/oauth/client.json' || req.url?.startsWith('/oauth/client-')) {
        const clientId = `${origin}${req.url}`;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
        res.end(
          JSON.stringify({
            client_id: clientId,
            client_name: 'Murdock’s notebook (spike client)',
            client_uri: `${origin}/`,
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          }),
        );
        return;
      }
      if (req.url === '/oauth/redirect.json') {
        res.writeHead(302, { location: `${origin}/oauth/client.json` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `https://${FIXTURE_HOST}:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    hits,
    tmp,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// -------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function probe(base: string, paths: string[], cookie?: string) {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const r = await fetch(`${base}${p}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    const text = await r.text();
    let summary: unknown = text.slice(0, 120);
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      summary = {
        issuer: j.issuer,
        resource: j.resource,
        authorization_servers: j.authorization_servers,
        authorization_endpoint: j.authorization_endpoint,
        token_endpoint: j.token_endpoint,
        registration_endpoint: j.registration_endpoint,
        jwks_uri: j.jwks_uri,
        client_id_metadata_document_supported: j.client_id_metadata_document_supported,
        code_challenge_methods_supported: j.code_challenge_methods_supported,
        scopes_supported: j.scopes_supported,
        keys: Array.isArray(j.keys) ? j.keys.length : undefined,
        token: typeof j.token === 'string' ? `${j.token.slice(0, 12)}…` : undefined,
        error: j.error ?? j.code,
      };
    } catch {}
    out[`GET ${p}`] = { status: r.status, body: summary };
  }
  return out;
}

class SpikeOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private _tokens?: Parameters<OAuthClientProvider['saveTokens']>[0];
  private _client?: Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
  private _verifier = '';
  savedClientInformation: unknown[] = [];
  constructor(
    readonly clientMetadataUrl: string,
    private readonly redirect: string,
  ) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata() {
    return {
      client_name: 'Murdock’s notebook (spike client)',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this._client;
  }
  saveClientInformation(info: NonNullable<typeof this._client>) {
    this.savedClientInformation.push(info);
    this._client = info;
  }
  tokens() {
    return this._tokens;
  }
  saveTokens(t: NonNullable<typeof this._tokens>) {
    this._tokens = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this._verifier = v;
  }
  codeVerifier() {
    return this._verifier;
  }
}

// -------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  await createDatabase(say);
  const authPool = new pg.Pool({ connectionString: roleUrl('auth'), max: 5 });
  const whoIsAuth = await authPool.query<{ u: string }>('SELECT current_user AS u');

  const redirectUri = 'http://127.0.0.1:53682/callback'; // never listened on: the "browser" reads Location
  const fixture = await startFixture(redirectUri);
  const fetchLog: FetchLogEntry[] = [];
  // The transport the plugin calls; swapped per check. Each check uses its own client_id URL,
  // so the plugin's cache and failure pacing never mask a result.
  let transport: ClientMetadataResourceFetch = createGuardedCimdFetch({
    allowPrivate: true,
    label: 'guardedFetch{allowPrivate:true}',
    log: fetchLog,
  });

  const port = await freePort();
  const state = {
    auth: undefined as unknown as SpikeAuth,
    wellKnown: 'none' as ServerState['wellKnown'],
    mcpGuard: 'requireMcpAuth' as ServerState['mcpGuard'],
    requests: [] as string[],
    toolCalls: [] as unknown[],
    jwtClaims: [] as unknown[],
  };
  state.auth = createSpikeAuth({
    pool: authPool,
    publicUrl: `http://127.0.0.1:${port}`,
    secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    fetchClientMetadataResource: (input, init) => transport(input, init),
  });
  const server = await startKept(state, { port });
  const base = `http://127.0.0.1:${port}`;
  const resource = `${base}/mcp`;
  say('env', {
    node: process.version,
    authPoolUser: whoIsAuth.rows[0]?.u,
    kept: base,
    fixture: fixture.origin,
    fixtureResolves: '127.0.0.1.nip.io -> 127.0.0.1 (public DNS)',
  });

  try {
    // ---- a user, created server-side as Kept's sign-up does (the HTTP route is disabled) ----
    const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
    await state.auth.api.signUpEmail({
      body: { email: 'louis@kept.test', password, name: 'Louis' },
    });
    const signIn = await fetch(`${base}/api/v1/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'louis@kept.test', password }),
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    say('signIn', { status: signIn.status, cookieNames: cookie.split('; ').map((c) => c.split('=')[0]) });

    // ---- 1. discovery documents, as served ----
    const discoveryPaths = [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/v1/auth',
      '/.well-known/openid-configuration',
      '/.well-known/openid-configuration/api/v1/auth',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/api/v1/auth/.well-known/oauth-authorization-server',
      '/api/v1/auth/.well-known/openid-configuration',
      '/api/v1/auth/.well-known/oauth-protected-resource',
      '/api/v1/auth/.well-known/oauth-protected-resource/mcp',
      '/api/v1/auth/jwks',
    ];
    say('discovery: only /api/v1/auth/* routed to auth.handler', await probe(base, discoveryPaths));
    state.wellKnown = 'mounted';
    say(
      'discovery: root /.well-known/oauth-authorization-server* -> oauthProviderAuthServerMetadata, other root /.well-known/* -> auth.handler unchanged',
      await probe(base, discoveryPaths),
    );
    // Does the official client find the AS metadata when only the protected-resource document
    // is at the root? buildDiscoveryUrls is the SDK's own candidate list for the issuer.
    const issuer = `${base}/api/v1/auth`;
    state.wellKnown = 'prm-only';
    const tried: string[] = [];
    let asFound: unknown;
    try {
      const md = await discoverAuthorizationServerMetadata(issuer, {
        fetchFn: async (input, init) => {
          const r = await fetch(input, init);
          tried.push(`${new URL(String(input instanceof Request ? input.url : input)).pathname} -> ${r.status}`);
          return r;
        },
      });
      asFound = md ? { issuer: md.issuer } : 'undefined (not found)';
    } catch (err) {
      asFound = describe(err);
    }
    say('MCP client 2.2.0: AS metadata discovery for issuer <base>/api/v1/auth', {
      candidateOrder: buildDiscoveryUrls(issuer).map((c) => `${c.type} ${c.url.pathname}`),
      withAsMetadataNotAtRoot: { tried, result: asFound },
    });
    state.wellKnown = 'mounted';
    say('jwt plugin endpoints', await probe(base, ['/api/v1/auth/token'], cookie));

    // ---- 2. unauthenticated /mcp ----
    const noToken = await fetch(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    say('POST /mcp without a token (requireMcpAuth)', {
      status: noToken.status,
      wwwAuthenticate: noToken.headers.get('www-authenticate'),
      body: (await noToken.text()).slice(0, 200),
    });

    // ---- 3. the full flow with the official MCP client ----
    const clientIdUrl = `${fixture.origin}/oauth/client.json`;
    const provider = new SpikeOAuthProvider(clientIdUrl, redirectUri);
    const clientRequests: string[] = [];
    const loggingFetch: typeof fetch = async (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      const r = await fetch(input, init);
      clientRequests.push(`${init?.method ?? 'GET'} ${u.pathname} -> ${r.status}`);
      return r;
    };
    const timings: Record<string, number> = {};
    let t = performance.now();
    const client1 = new Client({ name: 'kept-spike-client', version: '0.0.0' });
    const transport1 = new StreamableHTTPClientTransport(new URL(resource), {
      authProvider: provider,
      fetch: loggingFetch,
    });
    let connectError = '';
    try {
      await client1.connect(transport1);
    } catch (err) {
      connectError = err instanceof UnauthorizedError ? 'UnauthorizedError (expected)' : describe(err);
    }
    timings.discoveryToAuthorizeUrlMs = performance.now() - t;
    const authUrl = provider.authorizationUrl;
    say('client: first connect', {
      connectError,
      requestsMadeByTheSdk: [...clientRequests],
      authorizationUrl: authUrl && {
        origin: authUrl.origin,
        path: authUrl.pathname,
        params: Object.fromEntries(
          [...authUrl.searchParams].map(([k, v]) =>
            ['code_challenge', 'state'].includes(k) ? [k, `${v.slice(0, 6)}…`] : [k, v],
          ),
        ),
      },
      savedClientInformation: provider.savedClientInformation,
    });
    if (!authUrl) throw new Error('the SDK never produced an authorization URL');

    // The browser: GET the authorization URL with the session cookie.
    t = performance.now();
    const fetchesBefore = fetchLog.length;
    // A browser navigation gets a 302. Node's fetch (undici) always sends its own
    // `sec-fetch-mode: cors`, which Better Auth reads as a script fetch, so the answer here is
    // JSON {redirect: true, url}: the same target, read from the body instead of Location.
    const authorize = await fetch(authUrl, { headers: { cookie, ...NAVIGATE }, redirect: 'manual' });
    timings.authorizeMs = performance.now() - t;
    const authorizeBody = authorize.status === 302 ? undefined : ((await authorize.json()) as { redirect?: boolean; url?: string });
    const consentLocation = authorize.headers.get('location') ?? authorizeBody?.url ?? null;
    say('browser: GET authorize', {
      status: authorize.status,
      contentType: authorize.headers.get('content-type'),
      answer: authorizeBody ? { redirect: authorizeBody.redirect, urlPath: consentLocation && new URL(consentLocation, base).pathname } : 'Location header',
      consentPageParams: consentLocation && [...new URL(consentLocation, base).searchParams.keys()],
      metadataFetches: fetchLog.slice(fetchesBefore),
      fixtureHits: [...fixture.hits],
    });
    if (!consentLocation) throw new Error('no redirect from authorize');
    const consentUrl = new URL(consentLocation, base);

    // The consent page: the client's name, from Better Auth's public-client endpoint.
    const pc = await fetch(
      `${base}/api/v1/auth/oauth2/public-client?client_id=${encodeURIComponent(consentUrl.searchParams.get('client_id') ?? '')}`,
      { headers: { cookie } },
    );
    const publicClient = (await pc.json()) as Record<string, unknown>;
    say('consent page: GET /oauth2/public-client', { status: pc.status, body: publicClient });

    t = performance.now();
    const consent = await fetch(`${base}/api/v1/auth/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }),
      redirect: 'manual',
    });
    timings.consentMs = performance.now() - t;
    const consentBody = (await consent.json()) as { redirect_uri?: string; url?: string };
    const callback = new URL(consentBody.redirect_uri ?? consentBody.url ?? '');
    say('consent: POST /oauth2/consent', {
      status: consent.status,
      bodyKeys: Object.keys(consentBody),
      callbackOrigin: callback.origin + callback.pathname,
      callbackParams: [...callback.searchParams.keys()],
    });

    // Back in the client: exchange the code (PKCE verifier from the provider).
    t = performance.now();
    const beforeToken = clientRequests.length;
    await transport1.finishAuth(callback.searchParams);
    timings.tokenExchangeMs = performance.now() - t;
    const tokens = provider.tokens();
    const access = tokens?.access_token ?? '';
    let jwtShape: unknown = 'not a JWT';
    try {
      jwtShape = { header: decodeProtectedHeader(access), claims: decodeJwt(access) };
    } catch {}
    say('token response', {
      requests: clientRequests.slice(beforeToken),
      token_type: tokens?.token_type,
      expires_in: tokens?.expires_in,
      scope: tokens?.scope,
      hasRefreshToken: Boolean(tokens?.refresh_token),
      accessTokenLength: access.length,
      accessTokenIsJwt: access.split('.').length === 3,
      jwt: jwtShape,
    });

    // Tool calls with the issued token: both verifiers, the client's default (legacy
    // handshake) and its `versionNegotiation: {mode: 'auto'}` probe for 2026-07-28.
    const runs = [
      ['requireMcpAuth', 'legacy'],
      ['verifyBearerToken', 'legacy'],
      ['requireMcpAuth', 'auto'],
      ['verifyBearerToken', 'auto'],
    ] as const;
    for (const [guard, mode] of runs) {
      state.mcpGuard = guard;
      const client = new Client(
        { name: 'kept-spike-client', version: '0.0.0' },
        { versionNegotiation: { mode } },
      );
      const tr = new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider, fetch: loggingFetch });
      const mark = clientRequests.length;
      t = performance.now();
      await client.connect(tr);
      const tools = await client.listTools();
      const call = await client.callTool({ name: 'whoami', arguments: {} });
      timings[`connect+list+call via ${guard}, negotiation ${mode}`] = performance.now() - t;
      say(`tool call via ${guard}, versionNegotiation ${mode}`, {
        protocolVersion: tr.protocolVersion,
        tools: tools.tools.map((x) => x.name),
        result: call.content,
        requests: clientRequests.slice(mark),
      });
      await client.close();
    }
    say('JWT claims seen by each verifier', state.jwtClaims.slice(-2));
    say('timings (ms)', Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])));
    say('oauth_client row (as kept_auth)', (await authPool.query(
      `SELECT client_id, client_discovery_id, name, token_endpoint_auth_method, require_pkce, redirect_uris, scopes, user_id IS NULL AS no_owner
         FROM auth.oauth_client`,
    )).rows);
    say('rows per new table', (await authPool.query(
      `SELECT 'jwks' t, count(*) FROM auth.jwks UNION ALL SELECT 'oauth_client', count(*) FROM auth.oauth_client
       UNION ALL SELECT 'oauth_resource', count(*) FROM auth.oauth_resource UNION ALL SELECT 'oauth_client_resource', count(*) FROM auth.oauth_client_resource
       UNION ALL SELECT 'oauth_consent', count(*) FROM auth.oauth_consent UNION ALL SELECT 'oauth_access_token', count(*) FROM auth.oauth_access_token
       UNION ALL SELECT 'oauth_refresh_token', count(*) FROM auth.oauth_refresh_token`,
    )).rows);

    // ---- 4. negative checks ----
    const pkce = { code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };
    const tryAuthorize = async (clientId: string) => {
      const u = new URL(`${base}/api/v1/auth/oauth2/authorize`);
      for (const [k, v] of Object.entries({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'kept:read',
        state: 'x',
        resource,
        ...pkce,
      }))
        u.searchParams.set(k, v);
      const mark = fetchLog.length;
      const r = await fetch(u, { headers: { cookie, ...NAVIGATE }, redirect: 'manual' });
      const loc = r.headers.get('location');
      return {
        status: r.status,
        location: loc ? `${new URL(loc, base).pathname}?${[...new URL(loc, base).searchParams].map(([k, v]) => `${k}=${v}`).join('&')}` : undefined,
        body: r.status >= 300 && r.status < 400 ? undefined : (await r.text()).slice(0, 240),
        transportLog: fetchLog.slice(mark),
      };
    };
    const negatives: Record<string, unknown> = {};

    transport = createGuardedCimdFetch({ allowPrivate: false, label: 'guardedFetch{allowPrivate:false}, system DNS', log: fetchLog });
    negatives['N1 loopback-resolving public name, guard on'] = await tryAuthorize(`${fixture.origin}/oauth/client-n1.json`);

    const toPrivate: Resolve = (_host, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]);
    transport = createGuardedCimdFetch({ allowPrivate: false, resolve: toPrivate, label: 'guardedFetch{allowPrivate:false, resolve: *->10.0.0.5}', log: fetchLog });
    negatives['N2 name resolving to 10.0.0.5 (injected resolver), guard on'] = await tryAuthorize('https://client.kept-spike.test/oauth/client.json');

    transport = createGuardedCimdFetch({ allowPrivate: true, label: 'guardedFetch{allowPrivate:true}', log: fetchLog });
    negatives['N3 metadata URL answers 302, guard with allowPrivate:true'] = await tryAuthorize(`${fixture.origin}/oauth/redirect.json`);

    transport = async (input, init) => {
      const started = performance.now();
      try {
        const r = await betterAuthNodeFetch(input, init);
        fetchLog.push({ transport: '@better-auth/cimd/node', url: String(input), ms: performance.now() - started, status: r.status });
        return r;
      } catch (err) {
        fetchLog.push({ transport: '@better-auth/cimd/node', url: String(input), ms: performance.now() - started, error: describe(err) });
        throw err;
      }
    };
    negatives['N4 @better-auth/cimd/node on the loopback-resolving name'] = await tryAuthorize(`${fixture.origin}/oauth/client-n4.json`);

    // N8: a client that sends no `resource` (the V15 question "does it send resource?"): the
    // same code + PKCE flow by hand, then what the token is and whether /mcp takes it.
    {
      transport = createGuardedCimdFetch({ allowPrivate: true, label: 'guardedFetch{allowPrivate:true}', log: fetchLog });
      const verifierBytes = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifierBytes))).toString('base64url');
      const cid = `${fixture.origin}/oauth/client-n8.json`;
      const u = new URL(`${base}/api/v1/auth/oauth2/authorize`);
      for (const [k, v] of Object.entries({ client_id: cid, response_type: 'code', redirect_uri: redirectUri, scope: 'kept:read', state: 'n8', code_challenge: challenge, code_challenge_method: 'S256' }))
        u.searchParams.set(k, v);
      const a = (await (await fetch(u, { headers: { cookie, ...NAVIGATE }, redirect: 'manual' })).json()) as { url?: string };
      const consentQuery = new URL(a.url ?? '', base).search.slice(1);
      const c = (await (await fetch(`${base}/api/v1/auth/oauth2/consent`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ accept: true, oauth_query: consentQuery }),
      })).json()) as { url?: string };
      const code = new URL(c.url ?? '').searchParams.get('code') ?? '';
      const tok = await fetch(`${base}/api/v1/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cid, code_verifier: verifierBytes }),
      });
      const tj = (await tok.json()) as { access_token?: string; token_type?: string; error?: string };
      const at = tj.access_token ?? '';
      const isJwt = at.split('.').length === 3;
      const mcpTry: Record<string, number> = {};
      for (const guard of ['requireMcpAuth', 'verifyBearerToken'] as const) {
        state.mcpGuard = guard;
        const r = await fetch(resource, {
          method: 'POST',
          headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        mcpTry[guard] = r.status;
      }
      negatives['N8 flow without `resource`'] = {
        tokenStatus: tok.status,
        token_type: tj.token_type,
        error: tj.error,
        accessTokenIsJwt: isJwt,
        claims: isJwt ? decodeJwt(at) : undefined,
        accessTokenLength: at.length,
        mcpStatusByGuard: mcpTry,
        storedOpaqueRows: (await authPool.query('SELECT count(*)::int AS n FROM auth.oauth_access_token')).rows[0],
      };
    }

    // L1: not signed in yet. authorize sends the browser to loginPage with a signed query; the
    // sign-in page posts it back as `oauth_query` (what oauthProviderClient does in a browser),
    // and the sign-in answer carries where to go next. This is what T22's sign-in page must do.
    {
      transport = createGuardedCimdFetch({ allowPrivate: true, label: 'guardedFetch{allowPrivate:true}', log: fetchLog });
      const u = new URL(`${base}/api/v1/auth/oauth2/authorize`);
      for (const [k, v] of Object.entries({ client_id: `${fixture.origin}/oauth/client-l1.json`, response_type: 'code', redirect_uri: redirectUri, scope: 'kept:read', state: 'l1', resource, ...pkce }))
        u.searchParams.set(k, v);
      const a = await fetch(u, { headers: NAVIGATE, redirect: 'manual' });
      const aj = (await a.json()) as { url?: string };
      const login = new URL(aj.url ?? '', base);
      const si = await fetch(`${base}/api/v1/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: 'louis@kept.test', password, oauth_query: login.search.slice(1) }),
      });
      const sj = (await si.json()) as Record<string, unknown>;
      negatives['L1 sign-in continues the authorization'] = {
        authorize: { status: a.status, to: login.pathname, params: [...new Set(login.searchParams.keys())] },
        signIn: {
          status: si.status,
          keys: Object.keys(sj),
          redirect: sj.redirect,
          next: typeof sj.url === 'string' ? new URL(sj.url, base).pathname : undefined,
        },
      };
    }

    const dcr = await fetch(`${base}/api/v1/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'dcr', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    });
    negatives['N5 DCR while off: POST /oauth2/register'] = { status: dcr.status, body: (await dcr.text()).slice(0, 200) };

    // The jwt plugin's own session JWT (GET /token, and the set-auth-jwt header on get-session):
    // same signing key and issuer, audience = the base URL. Both verifiers must refuse it.
    const sessionJwtRes = await fetch(`${base}/api/v1/auth/token`, { headers: { cookie } });
    const sessionJwt = ((await sessionJwtRes.json()) as { token?: string }).token ?? '';
    const gs = await fetch(`${base}/api/v1/auth/get-session`, { headers: { cookie } });
    negatives['N7a get-session answers with a set-auth-jwt header'] = {
      status: gs.status,
      setAuthJwt: gs.headers.get('set-auth-jwt') ? 'present (a JWT)' : 'absent',
      sessionJwtClaims: sessionJwt ? { ...decodeJwt(sessionJwt), email: '…', name: '…' } : null,
    };
    for (const guard of ['requireMcpAuth', 'verifyBearerToken'] as const) {
      state.mcpGuard = guard;
      const r = await fetch(resource, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionJwt}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      negatives[`N7b session JWT from /token presented to /mcp via ${guard}`] = {
        status: r.status,
        wwwAuthenticate: r.headers.get('www-authenticate'),
      };
    }

    state.mcpGuard = 'verifyBearerToken';
    const badTok = await fetch(resource, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    negatives['N6 bad token via verifyBearerToken'] = {
      status: badTok.status,
      wwwAuthenticate: badTok.headers.get('www-authenticate'),
    };
    say('negative checks', negatives);
    say('all CIMD transport calls', fetchLog.map((e) => ({ ...e, ms: Math.round(e.ms) })));
    say('server request log', state.requests);
  } finally {
    server.close();
    await fixture.close();
    rmSync(fixture.tmp, { recursive: true, force: true });
    await authPool.end();
    if (!process.env.SPIKE_KEEP_DB) await dropDatabase();
    results.databaseDropped = !process.env.SPIKE_KEEP_DB;
    writeFileSync(path.join(here, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
