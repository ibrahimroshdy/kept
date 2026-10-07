// Variant B: main imports everything dynamically, tracing first.
const { otel } = await import('./tracing.mjs');
const { start } = await import('./app.mjs');
await start(otel);
