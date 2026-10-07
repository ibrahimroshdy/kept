/**
 * Spike S6.1 (step-6 plan, T0): the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.2.0)
 * mounted at POST /mcp in Fastify 5.12.5, two ways:
 *   (a) `toNodeHandler` from `@modelcontextprotocol/node` 2.1.0 (Fastify's `reply.hijack()`,
 *       `req.raw.auth` = the AuthInfo, Fastify's parsed body as `parsedBody`);
 *   (b) a web `Request` built by hand from Fastify's request, `handler.fetch(request,
 *       {authInfo, parsedBody})`, and the `Response` copied onto Fastify's reply.
 * Each under `legacy: 'stateless'` and `legacy: 'reject'`, `responseMode: 'json'`, called by
 * `@modelcontextprotocol/client` 2.2.0 pinned to 2026-07-28 and in its default ('legacy', the 2025
 * handshake) mode. Host and Origin validation run in front (hostHeaderValidationResponse,
 * originValidationResponse).
 *
 * Run (from this folder, after `npm ci`):  node --import tsx mcp-fastify.spike.ts
 * Writes results-<date>.json beside this file. Nothing leaves loopback.
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
  type AuthInfo,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';

type Legacy = 'stateless' | 'reject';
type Mount = 'a-toNodeHandler' | 'b-byHand';

const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', 'kept.example'];
const ALLOWED_ORIGINS = ['kept.example'];

let factoryRuns = 0;
let httpRequests = 0;
const factoryEras: string[] = [];
const seenAuth: (string | null)[] = [];

// A tool result of ~7 KB of compact JSON, near Kept's 8 KB output limit (D63).
const BIG = Array.from({ length: 50 }, (_, i) => ({
  id: `0190f6a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
  short_code: `K${String(i).padStart(5, '0')}`,
  path: ['Home', 'Garage', `Box ${i}`],
  untrusted: { name: `HDMI cable ${i}` },
}));

function factory(ctx: { era: 'legacy' | 'modern'; authInfo?: AuthInfo }) {
  factoryRuns++;
  factoryEras.push(ctx.era);
  seenAuth.push(ctx.authInfo?.clientId ?? null);
  const server = new McpServer({ name: 'kept-spike', version: '0.0.0' });
  // The factory reads ctx.authInfo and registers only what this principal may call (D113).
  const scopes = ctx.authInfo?.scopes ?? [];
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Which token is calling?',
      inputSchema: z.object({}),
      outputSchema: z.object({ client: z.string(), scopes: z.array(z.string()) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = { client: ctx.authInfo?.clientId ?? 'none', scopes };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );
  server.registerTool(
    'search_things',
    {
      description: 'A ~7.5 KB answer',
      inputSchema: z.object({ q: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = { data: BIG, as_of: '2026-09-30T00:00:00Z' };
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  );
  if (scopes.includes('kept:write')) {
    server.registerTool(
      'mark_seen',
      { description: 'A write tool, only for write tokens', inputSchema: z.object({ id: z.string() }) },
      async () => ({ content: [{ type: 'text', text: '{"data":{"ok":true}}' }] }),
    );
  }
  return server;
}

const AUTH_READ: AuthInfo = {
  token: 'kpt_spike_not_a_real_token',
  clientId: 'token:bruce-home-read',
  scopes: ['kept:read'],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function validate(request: Request): Response | undefined {
  return (
    hostHeaderValidationResponse(request, ALLOWED_HOSTS) ??
    originValidationResponse(request, ALLOWED_ORIGINS)
  );
}

function requestFromFastify(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url}`;
  const hasBody = req.method === 'POST' && req.body !== undefined;
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body) : undefined,
  });
}

// Fastify 5 sends a web `Response` itself (lib/reply.js: status, headers, and the body streamed),
// so an SSE answer is streamed, not buffered.
async function sendResponse(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  return reply.send(res);
}

async function startApp(mount: Mount, legacy: Legacy) {
  const app = Fastify({ logger: false });
  const handler: McpHttpHandler = createMcpHandler(factory, {
    legacy,
    responseMode: 'json',
    maxRequestBodySize: 1_048_576,
    onerror: () => {},
  });
  const nodeHandler = toNodeHandler(handler);
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/mcp')) httpRequests++;
  });
  app.post('/mcp', async (req, reply) => {
    const probe = requestFromFastify(req);
    const rejected = validate(probe);
    if (rejected) return sendResponse(reply, rejected);
    // Kept's verifier would run here (T10/T12): it sets the principal from the bearer token.
    const authInfo = AUTH_READ;
    if (mount === 'a-toNodeHandler') {
      reply.hijack();
      (req.raw as typeof req.raw & { auth?: AuthInfo }).auth = authInfo;
      await nodeHandler(req.raw as never, reply.raw as never, req.body);
      return;
    }
    const res = await handler.fetch(probe, { authInfo, parsedBody: req.body });
    return sendResponse(reply, res);
  });
  // Stateless (D63): GET and DELETE are 405 by Kept's own route, whatever the SDK would say.
  app.get('/mcp', async (_req, reply) => reply.status(405).send());
  app.delete('/mcp', async (_req, reply) => reply.status(405).send());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { app, handler, port: addr.port };
}

type Wire = { status: number; contentType: string | null; bytes: number; method: string };

function recordingFetch(log: Wire[]): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const clone = res.clone();
    const body = await clone.arrayBuffer();
    let method = '?';
    try {
      const b = JSON.parse(String(init?.body ?? '{}'));
      method = Array.isArray(b) ? 'batch' : (b.method ?? '?');
    } catch {}
    log.push({ status: res.status, contentType: res.headers.get('content-type'), bytes: body.byteLength, method });
    return res;
  };
}

async function clientRun(port: number, era: 'modern' | 'legacy') {
  const wire: Wire[] = [];
  const client = new Client(
    { name: 'kept-spike-client', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    fetch: recordingFetch(wire),
  });
  const before = { factory: factoryRuns, http: httpRequests };
  const out: Record<string, unknown> = { era };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    out.tools = tools.tools.map((t) => t.name);
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    out.whoami = who.structuredContent ?? who.content;
    const big = await client.callTool({ name: 'search_things', arguments: { q: 'hdmi' } });
    const text = (big.content as { type: string; text?: string }[])[0]?.text ?? '';
    out.bigToolTextBytes = Buffer.byteLength(text);
    const bad = await client
      .callTool({ name: 'whoami_missing', arguments: {} })
      .then((r) => ({ isError: r.isError, content: r.content }))
      .catch((e: Error) => ({ threw: e.name, message: e.message.slice(0, 200) }));
    out.unknownTool = bad;
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = `${(e as Error).name}: ${(e as Error).message.slice(0, 300)}`;
  } finally {
    await client.close().catch(() => {});
  }
  out.wire = wire;
  out.factoryRuns = factoryRuns - before.factory;
  out.httpRequests = httpRequests - before.http;
  return out;
}

function rawPost(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data.slice(0, 300), contentType: res.headers['content-type'] }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function guards(port: number) {
  const init = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  });
  return {
    foreignHost: await rawPost(port, { host: 'evil.example' }, init),
    foreignOrigin: await rawPost(port, { origin: 'https://evil.example' }, init),
    keptOrigin: await rawPost(port, { origin: 'https://kept.example' }, init),
    noOrigin: await rawPost(port, {}, init),
    wrongContentType: await rawPost(port, { 'content-type': 'text/plain' }, init),
  };
}

async function main() {
  const results: Record<string, unknown>[] = [];
  for (const mount of ['a-toNodeHandler', 'b-byHand'] as Mount[]) {
    for (const legacy of ['stateless', 'reject'] as Legacy[]) {
      const { app, handler, port } = await startApp(mount, legacy);
      const modern = await clientRun(port, 'modern');
      const old = await clientRun(port, 'legacy');
      const g = await guards(port);
      const get = await fetch(`http://127.0.0.1:${port}/mcp`).then((r) => r.status);
      results.push({ mount, legacy, modern, legacyClient: old, guards: g, getStatus: get });
      await handler.close();
      await app.close();
    }
  }
  const summary = {
    date: new Date().toISOString(),
    versions: {
      node: process.version,
      server: '2.2.0',
      nodeAdapter: '2.1.0',
      client: '2.2.0',
      fastify: '5.12.5',
    },
    factoryRunsTotal: factoryRuns,
    httpRequestsTotal: httpRequests,
    factoryEras: Object.fromEntries(['modern', 'legacy'].map((e) => [e, factoryEras.filter((x) => x === e).length])),
    authSeenByFactory: [...new Set(seenAuth)],
    results,
  };
  const file = new URL(`./results-${new Date().toLocaleDateString("en-CA")}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
