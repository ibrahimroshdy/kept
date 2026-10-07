import pg from 'pg';
import type { Pools } from '../../src/db/pools.js';
import { buildApp } from '../../src/http/app.js';
import { errorReportingActive } from '../../src/observability/errors.js';
import { activeTracing } from '../../src/observability/state.js';

// observability.test.ts's child process: Kept's app with the tracing preload (or not), the
// variables the parent chose, one healthy request and one failing request carrying a query
// string, a cookie and a header the reports must never hold. Prints one JSON line.

const env = process.env;
const pool = (url: string | undefined) => new pg.Pool({ connectionString: url, max: 2 });
const pools = {
  app: pool(env.CHILD_APP_URL),
  auth: pool(env.CHILD_AUTH_URL),
  system: pool(env.CHILD_SYSTEM_URL),
} as Pools;
const app = await buildApp({
  env: {
    KEPT_PUBLIC_URL: 'http://localhost:8091',
    KEPT_TRUSTED_PROXIES: [],
    ...(env.KEPT_ERROR_DSN ? { KEPT_ERROR_DSN: env.KEPT_ERROR_DSN } : {}),
  },
  pools,
});
app.get('/boom/:id', { config: { auth: 'none' } }, async () => {
  throw new Error('boom: Ibrahim keeps secret-message in the Garage');
});
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
const headers = { cookie: 'kept=secret-cookie', 'x-note': 'secret-header' };
const t0 = performance.now();
const ready = await fetch(`${base}/readyz?q=secret-query`, { headers });
const boom = await fetch(`${base}/boom/0b7c3d2e?q=secret-query`, { headers });
const ms = Math.round(performance.now() - t0);
await ready.text();
await boom.text();
const tracing = activeTracing() !== null;
const errors = errorReportingActive();
const c0 = performance.now();
await app.close();
const closeMs = Math.round(performance.now() - c0);
await Promise.all(Object.values(pools).map((p) => p.end()));
const resolved = [...((globalThis as { __keptResolved?: Set<string> }).__keptResolved ?? [])];
const loaded = resolved.filter((u) =>
  /@opentelemetry[/+]|@fastify[/+]otel|@sentry[/+]|import-in-the-middle|require-in-the-middle/.test(
    u,
  ),
);
process.stdout.write(
  `${JSON.stringify({ ready: ready.status, boom: boom.status, ms, closeMs, tracing, errors, loaded })}\n`,
);
