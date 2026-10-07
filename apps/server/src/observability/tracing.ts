import type { SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { setActiveTracing } from './state.js';

// Optional OpenTelemetry tracing (D84; step-8 plan T14; docs/spikes/2026-10-06-step8-
// observability.md). Off by default: with OTEL_EXPORTER_OTLP_ENDPOINT unset this module loads no
// OpenTelemetry package at all and sends nothing anywhere.
//
// It must run before fastify and pg are first loaded, or their spans are missing (the spike's
// variant A), so it is a preload, not an import in main.ts:
//   node --import <server>/dist/observability/tracing.js <server>/dist/main.js
// (the image's ENTRYPOINT and ci-local's prod-boot pass it; T15/T25). Set, it traces incoming HTTP
// requests, Fastify's routes and Postgres queries (statements only: instrumentation-pg records no
// parameter values unless asked), and exports them over OTLP/protobuf to the operator's own
// collector, which the standard OTEL_* variables configure. Query strings are withheld from every
// HTTP span. A dead collector never delays a request (the batch processor exports in the
// background) and never holds a shutdown for more than SHUTDOWN_MS.

const SHUTDOWN_MS = 2_000;

export async function startTracing(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return false;
  const [
    { registerInstrumentations },
    { HttpInstrumentation },
    { PgInstrumentation },
    { OTLPTraceExporter },
    { BatchSpanProcessor, NodeTracerProvider },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    fastifyOtel,
  ] = await Promise.all([
    import('@opentelemetry/instrumentation'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@fastify/otel'),
  ]);
  // The exporter's default timeout is 10 s; a shorter one unless the operator set theirs.
  const exporter = new OTLPTraceExporter(
    env.OTEL_EXPORTER_OTLP_TIMEOUT || env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT
      ? {}
      : { timeoutMillis: 1_000 },
  );
  // Before export, every span drops what an error says: a status keeps its code without the
  // message, and an exception event keeps its type without the message or the stack (whose
  // first line repeats the message). Error messages can quote values (D84: nothing but timings,
  // routes and statements).
  const withholdErrors: SpanProcessor = {
    onStart(span) {
      const setStatus = span.setStatus.bind(span);
      span.setStatus = (status) => setStatus({ code: status.code });
      const recordException = span.recordException.bind(span);
      span.recordException = (exception, time) => {
        const name =
          typeof exception === 'object' && typeof exception.name === 'string'
            ? exception.name
            : 'Error';
        recordException({ name, message: '(withheld)' }, time);
      };
    },
    onEnd() {},
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'kept',
      [ATTR_SERVICE_VERSION]: env.KEPT_VERSION || '0.0.0-dev',
    }),
    spanProcessors: [withholdErrors, new BatchSpanProcessor(exporter)],
  });
  provider.register();
  type Settable = { setAttribute: (key: string, value: string) => unknown };
  // Route spans: the path without its query string, and no exception events (an error's message
  // can quote a value; error reporting says what failed, without it).
  const fastify = new fastifyOtel.FastifyOtelInstrumentation({
    recordExceptions: false,
    requestHook: (span, request) => {
      const q = request.url.indexOf('?');
      if (q >= 0) span.setAttribute('url.path', request.url.slice(0, q));
    },
  });
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        // A query string can hold a search (incoming) or a credential (outgoing): withheld.
        requestHook: (span: Settable, req) => {
          if ('method' in req && 'url' in req && typeof req.url === 'string') {
            if (req.url.includes('?')) span.setAttribute('url.query', '[withheld]');
            return;
          }
          const out = req as { protocol?: string; host?: string; path?: string };
          if (typeof out.path === 'string' && out.path.includes('?')) {
            span.setAttribute('url.query', '[withheld]');
            span.setAttribute(
              'url.full',
              `${out.protocol ?? 'http:'}//${out.host ?? ''}${out.path.split('?')[0]}`,
            );
          }
        },
      }),
      new PgInstrumentation(),
      fastify,
    ],
  });
  setActiveTracing({
    fastifyPlugin: () => fastify.plugin(),
    shutdown: async () => {
      await Promise.race([
        provider.shutdown().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_MS).unref()),
      ]);
    },
  });
  return true;
}

// As a preload (`node --import …/tracing.js`), it starts at once, before main.js is loaded.
await startTracing();
