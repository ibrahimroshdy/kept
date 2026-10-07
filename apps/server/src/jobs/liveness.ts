import { utimes, writeFile } from 'node:fs/promises';
import type { PgBoss } from 'pg-boss';

// The worker's liveness signal (step-1 carry-over; step-8 plan T13). A `KEPT_ROLE=worker`
// process serves no HTTP, so the image's HEALTHCHECK can't ask /readyz. Instead, every few
// seconds the worker looks at its pg-boss workers' last successful fetch (pg-boss's own
// `getWipData()`: `lastFetchedOn` is set only after a fetch from the database returned), and while
// one is recent it touches WORKER_ALIVE_FILE. `docker/healthcheck.mjs --worker` passes while that
// file is under two minutes old. A worker whose polling stopped (a lost database, a wedged event
// loop) stops touching it, and the container turns unhealthy.

/** Under /tmp, which the image keeps writable (compose.yaml mounts a tmpfs there). */
export const WORKER_ALIVE_FILE = '/tmp/kept-worker-alive';
/** How often the file is considered for a touch. */
const INTERVAL_MS = 15_000;
/** A fetch older than this is not "polling" (pg-boss polls every 2 s by default). */
const FRESH_MS = 60_000;

type WipSource = Pick<PgBoss, 'getWipData'>;

/** The newest successful fetch across this process's workers, or null. */
export function lastPoll(boss: WipSource): number | null {
  let last: number | null = null;
  for (const w of boss.getWipData({ includeInternal: true })) {
    if (w.lastFetchedOn !== null && (last === null || w.lastFetchedOn > last)) {
      last = w.lastFetchedOn;
    }
  }
  return last;
}

/** Touches the file when the last poll is fresh; returns whether it did. */
export async function beat(
  boss: WipSource,
  file: string = WORKER_ALIVE_FILE,
  now: number = Date.now(),
): Promise<boolean> {
  const last = lastPoll(boss);
  if (last === null || now - last > FRESH_MS) return false;
  const at = new Date(now);
  try {
    await utimes(file, at, at);
  } catch {
    await writeFile(file, '', { mode: 0o600 });
  }
  return true;
}

/** Starts the heartbeat; the returned function stops it. Never throws into the worker. */
export function startWorkerHeartbeat(
  boss: WipSource,
  opts: { file?: string; intervalMs?: number; onError?: (err: unknown) => void } = {},
): () => void {
  const tick = () => {
    beat(boss, opts.file).catch((err: unknown) => opts.onError?.(err));
  };
  const timer = setInterval(tick, opts.intervalMs ?? INTERVAL_MS);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
