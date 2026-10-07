import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, createThing, type Json, type Loc, ok, own } from '../../test/things.js';
import { cimdFetch } from './cimd-fetch.js';

// T12: OAuth connectors with Client ID Metadata Documents, end to end through the app: authorize
// (as Louis, signed in) → Kept's consent (read, Home only) → the token endpoint with PKCE → `/mcp`
// with the JWT → revoke in Connections. The client's metadata document is served by an in-memory
// transport for one allowed URL (isMetadataDocumentUrlAllowed): a fixture can't pass the real
// SSRF guard on a laptop, which only reaches loopback (spike S6.2's caveat); the guard's refusals
// are tested on the real transport below.

const CLIENT_ID = 'https://client.example/oauth/kept-client.json';
const REDIRECT = 'https://client.example/callback';
const METADATA = {
  client_id: CLIENT_ID,
  client_name: 'Murdock’s notebook',
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code'],
  response_types: ['code'],
};

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
let home: Loc;
let garage: Loc;
let fetched = 0;
const clients: Client[] = [];

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, {
    oauth: {
      publicUrl: 'http://localhost:5173',
      isMetadataDocumentUrlAllowed: (url) => url === CLIENT_ID,
      fetchClientMetadataResource: async (input) => {
        fetched += 1;
        const url = input instanceof Request ? input.url : String(input);
        if (url !== CLIENT_ID) return new Response('not found', { status: 404 });
        return Response.json(METADATA);
      },
    },
  });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, garage.id, louis.userId, 'member');
  await createThing(t, ibrahim, home, { name: 'HDMI cable' });
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

const host = () => new URL(t.publicUrl).host;

/** fetch() into the app (as mcp.test.ts). */
function injectFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    headers.host = url.host;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    const res = await t.app.inject({
      method: req.method as 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(body ? { payload: body } : {}),
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [String(v)]) out.append(k, one);
    }
    return new Response(
      res.statusCode === 202 || res.statusCode === 204 ? null : new Uint8Array(res.rawPayload),
      { status: res.statusCode, headers: out },
    );
  }) as typeof fetch;
}

async function mcpClient(accessToken: string): Promise<Client> {
  const client = new Client(
    { name: 'kept-oauth-test', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${t.publicUrl}/mcp`), {
      fetch: injectFetch(),
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  clients.push(client);
  return client;
}

/** authorize → the consent page's signed query (Better Auth answers a script with JSON). */
async function authorize(verifier: string): Promise<string> {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'kept:read kept:write',
    state: 'state-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${t.publicUrl}/mcp`,
  });
  const res = await call(t, `/api/v1/auth/oauth2/authorize?${q}`, {
    as: louis,
    headers: { accept: 'application/json' },
  });
  expect(res.statusCode, res.body).toBeLessThan(400);
  const target =
    (res.headers.location as string | undefined) ?? (res.json() as { url: string }).url;
  const consent = new URL(target, t.publicUrl);
  expect(consent.pathname).toBe('/oauth/consent');
  return consent.search.slice(1);
}

async function redeem(redirectTo: string, verifier: string): Promise<string> {
  const code = new URL(redirectTo).searchParams.get('code');
  expect(code).toBeTruthy();
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/oauth2/token',
    headers: { host: host(), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: `${t.publicUrl}/mcp`,
    }).toString(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { access_token: string }).access_token;
}

describe('OAuth connectors', () => {
  it('serves the discovery documents at the root, with CIMD and no registration endpoint', async () => {
    const as = await t.app.inject({
      url: '/.well-known/oauth-authorization-server/api/v1/auth',
      headers: { host: host() },
    });
    expect(as.statusCode).toBe(200);
    const meta = as.json() as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: `${t.publicUrl}/api/v1/auth`,
      client_id_metadata_document_supported: true,
    });
    expect(meta.registration_endpoint).toBeUndefined();
    const prm = await t.app.inject({
      url: '/.well-known/oauth-protected-resource/mcp',
      headers: { host: host() },
    });
    expect(prm.statusCode).toBe(200);
    expect(prm.json()).toMatchObject({ resource: `${t.publicUrl}/mcp` });
    // Dynamic Client Registration is off (Q8), and the jwt plugin's session JWT isn't served.
    const dcr = await call(t, '/api/v1/auth/oauth2/register', {
      body: { redirect_uris: [REDIRECT], client_name: 'Talia’s app' },
    });
    expect(dcr.statusCode).toBeGreaterThanOrEqual(400);
    expect((await call(t, '/api/v1/auth/token', { as: louis })).statusCode).toBe(404);
  });

  // Security review step 6 (T25, M1): the provider's session-authenticated client management
  // would let any signed-in person register a client with any redirect URI and name, DCR by
  // another door (Q8, D179). None of it is served.
  it('serves none of the provider’s client or consent management to a signed-in person', async () => {
    const made = await call(t, '/api/v1/auth/oauth2/create-client', {
      as: louis,
      body: { redirect_uris: ['https://evil.example/cb'], client_name: 'Claude' },
    });
    expect(made.statusCode, made.body).toBe(404);
    const posts = [
      '/oauth2/update-client',
      '/oauth2/client/rotate-secret',
      '/oauth2/delete-client',
      '/oauth2/update-consent',
      '/oauth2/delete-consent',
    ];
    for (const path of posts) {
      const res = await call(t, `/api/v1/auth${path}`, { as: louis, body: { client_id: 'x' } });
      expect(res.statusCode, path).toBe(404);
    }
    const gets = ['/oauth2/get-client?client_id=x', '/oauth2/get-clients', '/oauth2/get-consents'];
    for (const path of gets) {
      expect((await call(t, `/api/v1/auth${path}`, { as: louis })).statusCode, path).toBe(404);
    }
    const rows = await own(db, 'SELECT 1 FROM auth.oauth_client WHERE name = $1', ['Claude']);
    expect(rows).toHaveLength(0);
  });

  // catalogue: POST /api/v1/oauth/consent
  it('consents to Home, read only, and the app reads Home and nothing else until revoked', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const query = await authorize(verifier);
    expect(fetched).toBeGreaterThan(0);
    const view = ok(await call(t, `/api/v1/oauth/consent?${query}`, { as: louis }));
    expect(view.client).toMatchObject({ name: 'Murdock’s notebook' });
    expect((view.locations as Json[]).map((l) => l.id)).toEqual(
      expect.arrayContaining([home.id, garage.id]),
    );
    const decided = ok(
      await call(t, `/api/v1/oauth/consent?${query}`, {
        as: louis,
        body: { accept: true, scope: 'read', locationIds: [home.id] },
      }),
    );
    const events = await own<{ action: string; actor_id: string }>(
      db,
      `SELECT action, actor_id FROM public.audit_events WHERE action = 'oauth.grant'`,
    );
    expect(events).toEqual([{ action: 'oauth.grant', actor_id: louis.userId }]);
    const access = await redeem(decided.redirectTo as string, verifier);

    const client = await mcpClient(access);
    const tools = (await client.listTools()).tools.map((x) => x.name);
    expect(tools).toContain('where_is');
    expect(tools).not.toContain('create_place');
    const found = await client.callTool({ name: 'where_is', arguments: { query: 'HDMI' } });
    expect(found.isError).toBeFalsy();
    const elsewhere = await client.callTool({
      name: 'where_is',
      arguments: { query: 'HDMI', location_id: garage.id },
    });
    expect(elsewhere.isError).toBe(true);
    expect(JSON.stringify(elsewhere.content)).toContain('tool_unavailable');

    // Connections lists the app; revoking it refuses the next call though the JWT is unexpired.
    const tokens = ok(await call(t, '/api/v1/tokens?kind=oauth', { as: louis }));
    const grant = (tokens.items as Json[])[0] as Json;
    expect(grant).toMatchObject({ kind: 'oauth', clientName: 'Murdock’s notebook', scope: 'read' });
    expect(
      (await call(t, `/api/v1/tokens/${grant.id}`, { as: louis, method: 'DELETE' })).statusCode,
    ).toBe(204);
    const after = await t.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: host(),
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(after.statusCode).toBe(401);
    expect(String(after.headers['www-authenticate'])).toContain('resource_metadata=');
  });

  it('records a refusal and sends the client back without a code', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const query = await authorize(verifier);
    const decided = ok(
      await call(t, `/api/v1/oauth/consent?${query}`, {
        as: louis,
        body: { accept: false, scope: 'read', locationIds: [] },
      }),
    );
    expect(new URL(decided.redirectTo as string).searchParams.get('code')).toBeNull();
    const events = await own(db, `SELECT 1 FROM public.audit_events WHERE action = 'oauth.deny'`);
    expect(events).toHaveLength(1);
  });
});

describe('the CIMD transport (cimd-fetch.ts)', () => {
  it('refuses a client id whose name resolves to a private address, and logs why', async () => {
    const warned: object[] = [];
    const fetcher = cimdFetch({
      log: { warn: (obj) => warned.push(obj) },
      resolve: (_host, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]),
    });
    await expect(fetcher('https://client.example/oauth/x.json', {})).rejects.toThrow();
    expect(JSON.stringify(warned)).toContain('https://client.example/oauth/x.json');
    const loopback = cimdFetch({
      resolve: (_host, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    });
    await expect(loopback('https://client.example/oauth/x.json', {})).rejects.toThrow();
  });
});
