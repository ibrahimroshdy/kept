// The image's HEALTHCHECK (task 29; step-8 T13): the slim base has no curl, so node checks itself.
// - web or all (the default): healthy means the process serves HTTP on KEPT_PORT and both of its
//   database pools answer /readyz;
// - worker (KEPT_ROLE=worker, or `--worker`): it serves no HTTP, so healthy means its pg-boss
//   workers fetched from the database within the last two minutes, which the worker records by
//   touching /tmp/kept-worker-alive (apps/server/src/jobs/liveness.ts).
import { stat } from 'node:fs/promises';

const args = process.argv.slice(2);
const worker = args.includes('--worker') || process.env.KEPT_ROLE === 'worker';
// `--file=<path>` is for tests; the image always uses the default.
const file =
  args.find((a) => a.startsWith('--file='))?.slice('--file='.length) ?? '/tmp/kept-worker-alive';
const MAX_AGE_MS = 120_000;

if (worker) {
  try {
    const { mtimeMs } = await stat(file);
    process.exit(Date.now() - mtimeMs < MAX_AGE_MS ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

const port = process.env.KEPT_HEALTHCHECK_PORT ?? process.env.KEPT_PORT ?? '8080';
try {
  const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
