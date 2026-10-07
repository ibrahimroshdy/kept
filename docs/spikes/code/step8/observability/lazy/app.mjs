// Stands in for http/app.ts and db/pools.ts: static imports of fastify and pg.
import Fastify from 'fastify';
import pg from 'pg';

export async function start(otel) {
  const app = Fastify();
  if (otel) await app.register(otel.fastifyOtel.plugin());
  app.get('/q', async () => {
    // A dead Postgres (port 9): pg.connect fails fast; we only want to see whether a span appears.
    const client = new pg.Client({ host: '127.0.0.1', port: 9, user: 'x', database: 'x', connectionTimeoutMillis: 500 });
    try { await client.connect(); } catch {}
    return { ok: true };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/q`);
  await res.text();
  const ms = Math.round(performance.now() - t0);
  await app.close();
  let spans = [];
  if (otel) {
    spans = otel.memory.getFinishedSpans().map((s) => s.name);
    const t1 = performance.now();
    await otel.provider.shutdown().catch((e) => spans.push(`shutdown error: ${e.message}`));
    spans.push(`(shutdown ${Math.round(performance.now() - t1)} ms)`);
  }
  const loaded = globalThis.__keptLoaded ? [...globalThis.__keptLoaded].filter((u) => /@opentelemetry|@fastify\/otel|import-in-the-middle|require-in-the-middle/.test(u)).length : 'n/a';
  console.log(JSON.stringify({ variant: process.env.VARIANT, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null, status: res.status, requestMs: ms, otelModulesLoaded: loaded, spans }));
}
