import { performance } from 'node:perf_hooks';

// Timing for the performance checks (test/perf): p50, p95 and max of `runs` timed calls after
// `warmup` untimed ones, in milliseconds to one decimal.

export const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;

export function stats(samples: number[]) {
  const s = [...samples].sort((x, y) => x - y);
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    n: s.length,
    p50: r(pct(s, 50)),
    p95: r(pct(s, 95)),
    max: r(s.at(-1) as number),
  };
}

export async function timed(
  warmup: number,
  runs: number,
  fn: () => Promise<void>,
): Promise<ReturnType<typeof stats>> {
  const samples: number[] = [];
  for (let i = 0; i < warmup + runs; i++) {
    const start = performance.now();
    await fn();
    const ms = performance.now() - start;
    if (i >= warmup) samples.push(ms);
  }
  return stats(samples);
}
