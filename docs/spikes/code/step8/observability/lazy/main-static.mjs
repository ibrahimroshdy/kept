// Variant A: "one import at the top of main.ts" — a static import whose module has a top-level await.
import { otel } from './tracing.mjs';
import { start } from './app.mjs';
await start(otel);
