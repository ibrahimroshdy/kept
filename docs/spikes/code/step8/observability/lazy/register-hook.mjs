// Variant D: a conditional --import preload that registers OTel's ESM loader hook
// (import-in-the-middle) and then the setup, only when the endpoint is set.
import { register } from 'node:module';
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  await import('./tracing.mjs');
}
