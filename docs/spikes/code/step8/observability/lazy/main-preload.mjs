// Variant C/D: the tracing module was preloaded with --import; main just reads it.
import { otel } from './tracing.mjs';
import { start } from './app.mjs';
await start(otel);
