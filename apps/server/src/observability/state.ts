import type { FastifyPluginCallback } from 'fastify';

// What the optional tracing (D84; observability/tracing.ts) hands the app, kept in a module with
// no OpenTelemetry import, so http/app.ts can ask "is tracing on?" without loading any of it.

export type ActiveTracing = {
  /** `@fastify/otel`'s plugin: route-level spans under the HTTP server span. */
  fastifyPlugin: () => FastifyPluginCallback;
  /** Flushes and stops, bounded (a dead collector never holds a shutdown). */
  shutdown: () => Promise<void>;
};

let active: ActiveTracing | null = null;

export function setActiveTracing(tracing: ActiveTracing | null): void {
  active = tracing;
}

/** Null unless the process was started with tracing.ts preloaded and an OTLP endpoint set. */
export function activeTracing(): ActiveTracing | null {
  return active;
}
