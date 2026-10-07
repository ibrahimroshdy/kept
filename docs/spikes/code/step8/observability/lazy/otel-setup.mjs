// The heavy part: only ever imported when OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import FastifyOtelInstrumentation from '@fastify/otel';

export const memory = new InMemorySpanExporter();
// The OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself (+ /v1/traces).
export const otlp = new OTLPTraceExporter();
export const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(memory), new BatchSpanProcessor(otlp)],
});
provider.register();
export const fastifyOtel = new FastifyOtelInstrumentation();
registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [new HttpInstrumentation(), new PgInstrumentation(), fastifyOtel],
});
