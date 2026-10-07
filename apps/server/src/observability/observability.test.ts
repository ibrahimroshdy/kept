import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';

// Optional tracing and error reporting (D84; plan T14), each in a child process started the way
// the image starts Kept: `--import …/observability/tracing.ts` first. A local stub stands in for
// both the OTLP collector and the Sentry-compatible endpoint, so nothing reaches the internet,
// and every byte they are sent is searched for what must never leave.

const run = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRETS = ['secret-query', 'secret-cookie', 'secret-header', 'secret-message', 'Ibrahim'];

type Got = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };
let stub: Server;
let stubBase: string;
const got: Got[] = [];
let db: TestDb;

beforeAll(async () => {
  db = await testDb();
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));
beforeEach(() => {
  got.length = 0;
});

type ChildResult = {
  ready: number;
  boom: number;
  ms: number;
  closeMs: number;
  tracing: boolean;
  errors: boolean;
  loaded: string[];
};

async function child(extra: Record<string, string>): Promise<ChildResult> {
  const { stdout } = await run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './test/observability/record.ts',
      '--import',
      './src/observability/tracing.ts',
      './test/observability/child.ts',
    ],
    {
      cwd: serverRoot,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        CHILD_APP_URL: db.urls.app,
        CHILD_AUTH_URL: db.urls.auth,
        CHILD_SYSTEM_URL: db.urls.system,
        ...extra,
      },
    },
  );
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as ChildResult;
}

describe('with neither variable (the default)', () => {
  it('loads no tracing or reporting package and sends nothing anywhere', async () => {
    const result = await child({});
    expect(result).toMatchObject({ ready: 200, boom: 500, tracing: false, errors: false });
    // Only what better-auth loads itself: @opentelemetry/api (it asks for a tracer and falls
    // back to a no-op, spike O1) and semantic-conventions (its dependency, constants only). No
    // SDK, exporter, instrumentation, @fastify/otel or Sentry module.
    const better = /@opentelemetry[/+](api|semantic-conventions)[@/]/;
    expect(result.loaded.filter((u) => !better.test(u))).toEqual([]);
    expect(got).toEqual([]);
  });
});

describe('with OTEL_EXPORTER_OTLP_ENDPOINT and KEPT_ERROR_DSN', () => {
  it('traces HTTP and Postgres to the collector, and reports the 5xx with its request id and route only', async () => {
    const result = await child({
      OTEL_EXPORTER_OTLP_ENDPOINT: stubBase,
      KEPT_ERROR_DSN: `http://publickey@127.0.0.1:${new URL(stubBase).port}/42`,
    });
    expect(result).toMatchObject({ ready: 200, boom: 500, tracing: true, errors: true });

    const traces = got.filter((g) => g.url === '/v1/traces');
    expect(traces.length).toBeGreaterThan(0);
    const spans = Buffer.concat(traces.map((t) => t.body)).toString('latin1');
    // The HTTP server span, Fastify's route span and the readiness check's queries.
    expect(spans).toContain('/readyz');
    expect(spans).toContain('/boom/:id');
    expect(spans).toContain('SELECT 1');
    expect(spans).toContain('[withheld]');

    const envelopes = got.filter((g) => g.url.startsWith('/api/42/envelope/'));
    expect(envelopes).toHaveLength(1);
    const [, , item] = envelopes[0]?.body.toString('utf8').split('\n') ?? [];
    const event = JSON.parse(item ?? '{}') as Record<string, unknown> & {
      tags: Record<string, string>;
      exception: { values: { type: string; value: string; stacktrace?: unknown }[] };
    };
    expect(Object.keys(event).sort()).toEqual(
      [
        'environment',
        'event_id',
        'exception',
        'level',
        'platform',
        'release',
        'tags',
        'timestamp',
      ].filter((k) => k in event),
    );
    expect(event).not.toHaveProperty('request');
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('breadcrumbs');
    expect(event).not.toHaveProperty('extra');
    expect(event.tags.route).toBe('/boom/:id');
    expect(event.tags.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.exception.values[0]).toMatchObject({
      type: 'Error',
      value: 'Error (message withheld)',
    });
    expect(event.exception.values[0]?.stacktrace).toBeDefined();

    // Nothing that was in the request, nor the error's message, reached either endpoint.
    for (const g of got) {
      const all = `${g.url}\n${JSON.stringify(g.headers)}\n${g.body.toString('latin1')}`;
      for (const secret of SECRETS) expect(all, `${g.url} holds ${secret}`).not.toContain(secret);
      // A trace's url.path keeps the ids (the operator's own collector); a report has only the
      // route pattern.
      if (g.url.startsWith('/api/')) expect(all).not.toContain('0b7c3d2e');
    }
  });

  it('a dead collector delays no request and holds the shutdown at most about two seconds', async () => {
    const result = await child({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
    expect(result).toMatchObject({ ready: 200, boom: 500, tracing: true, errors: false });
    expect(result.ms).toBeLessThan(5_000);
    expect(result.closeMs).toBeLessThan(3_500);
  });
});
