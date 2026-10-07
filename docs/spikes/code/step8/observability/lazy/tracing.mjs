// What Kept's src/observability/tracing.ts would be: imported first; loads nothing unless the
// endpoint is set.
export const otel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? await import('./otel-setup.mjs')
  : null;
