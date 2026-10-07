import { OUTPUT_LIMIT_BYTES } from '@kept/mcp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, createThing, type Json, type Loc, ok, own } from '../../test/things.js';

// T11: `/mcp` through the official client (@modelcontextprotocol/client 2.2.0), with its HTTP
// routed into the app (app.inject), pinned to 2026-07-28 and in its default (2025) mode. Ibrahim
// owns Home (every module, MCP on) and Garage (essentials: no MCP); Louis is a member of both,
// Talia a viewer of Home.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
let talia: Person;
let home: Loc;
let garage: Loc;
const clients: Client[] = [];

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  // Token creation is https only (D181).
  t = await peopleApp(db, { publicUrl: 'https://kept.example' });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, garage.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await createThing(t, ibrahim, home, { name: 'HDMI cable' });
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

/** fetch() into the app: what a client on the network would send, through app.inject. */
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
      {
        status: res.statusCode,
        headers: out,
      },
    );
  }) as typeof fetch;
}

async function connect(secret: string, era: 'modern' | 'legacy' = 'modern'): Promise<Client> {
  const client = new Client(
    { name: 'kept-test', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${t.publicUrl}/mcp`), {
    fetch: injectFetch(),
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function token(who: Person, scope: 'read' | 'write', locationIds: string[]) {
  const res = await call(t, '/api/v1/tokens', {
    as: who,
    body: { name: `${scope} token`, scope, locationIds },
  });
  return ok(res, 201) as unknown as { token: Json; secret: string };
}

/** A tool's text, parsed, with its size checked against the 8 KB contract (D63). */
function answer(result: { content?: unknown; isError?: boolean }): Json {
  const part = (result.content as { type: string; text: string }[])[0];
  expect(part?.type).toBe('text');
  expect(Buffer.byteLength(part?.text ?? '')).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
  return JSON.parse(part?.text ?? '{}') as Json;
}

describe('/mcp', () => {
  it('lists read and write tools for a member’s write token, read tools for a viewer’s read token', async () => {
    const write = await connect((await token(louis, 'write', [home.id])).secret);
    const names = (await write.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['where_is', 'create_place', 'capabilities']));
    const read = await connect((await token(talia, 'read', [home.id])).secret);
    const readNames = (await read.listTools()).tools.map((x) => x.name);
    expect(readNames).toContain('where_is');
    expect(readNames).not.toContain('create_place');
    // Garage has MCP off: a token for Garage alone is offered nothing.
    const garageOnly = await connect((await token(louis, 'write', [garage.id])).secret);
    expect((await garageOnly.listTools()).tools).toEqual([]);
  });

  it('answers a read within the 8 KB contract, and a 2025-era client too', async () => {
    const { secret } = await token(louis, 'read', [home.id]);
    for (const era of ['modern', 'legacy'] as const) {
      const client = await connect(secret, era);
      const res = await client.callTool({ name: 'where_is', arguments: { query: 'HDMI' } });
      const body = answer(res);
      expect(res.isError, JSON.stringify(body)).toBeFalsy();
      expect(body.as_of).toBeTruthy();
      expect(JSON.stringify(body)).toContain('HDMI cable');
    }
  });

  it('writes as the token: audited as it, and listed in recent changes', async () => {
    const { token: made, secret } = await token(louis, 'write', [home.id]);
    const client = await connect(secret);
    const res = await client.callTool({
      name: 'create_place',
      arguments: { name: 'Box 3', kind: 'zone' },
    });
    const body = answer(res);
    expect(res.isError, JSON.stringify(body)).toBeFalsy();
    const events = await own<{ actor_type: string; actor_id: string; action: string }>(
      db,
      `SELECT actor_type, actor_id, action FROM public.audit_events
        WHERE actor_type = 'token' AND actor_id = $1`,
      [made.id],
    );
    expect(events).toEqual([{ actor_type: 'token', actor_id: made.id, action: 'place.create' }]);
    const changes = ok(await call(t, '/api/v1/connections/changes', { as: louis }));
    expect((changes.items as Json[]).map((c) => (c.token as Json).id)).toContain(made.id);
  });

  it('refuses a token per call once its creator loses the role (D180), in Kept’s words', async () => {
    const peter = await person(t, db, 'louis-two');
    const membership = await join(db, home.id, peter.userId, 'member');
    const { secret } = await token(peter, 'read', [home.id]);
    const client = await connect(secret);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await own(db, 'DELETE FROM public.memberships WHERE id = $1', [membership]);
    // The token is revoked with the membership: the next request is a 401 with the challenge.
    const res = await t.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: new URL(t.publicUrl).host,
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer /);
  });

  it('refuses a foreign Host or Origin, no token, and GET or DELETE', async () => {
    const { secret } = await token(louis, 'read', [home.id]);
    const base = {
      method: 'POST' as const,
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    };
    const headers = {
      host: new URL(t.publicUrl).host,
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    expect(
      (await t.app.inject({ ...base, headers: { ...headers, host: 'evil.example' } })).statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          ...base,
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    const { authorization: _, ...anonymous } = headers;
    expect((await t.app.inject({ ...base, headers: anonymous })).statusCode).toBe(401);
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await t.app.inject({
        method,
        url: '/mcp',
        headers: { host: headers.host, authorization: headers.authorization },
      });
      expect(res.statusCode, method).toBe(405);
    }
  });
});
