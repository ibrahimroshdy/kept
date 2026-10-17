// The runner's speed for the performance checks (test/perf; issue #159). The limits are fixed
// milliseconds, and the nightly job lands on GitHub runners of different speeds: the same commit
// passed on one and failed on another a day later, with everything about twice as slow.
//
// So the run first times a fixed reference workload (calibrate.ts: pure JavaScript, plain SQL and
// an exact vector scan, none of it Kept's code), compares it with REFERENCE_MS, and multiplies
// every millisecond limit by the resulting factor (never below 1). A real regression still fails:
// it slows the code under test, not the reference work, so the factor doesn't grow with it.
//
// This file is the arithmetic only, with no database, so the normal suite unit-tests it
// (test/perf-calibration.test.ts).

/** The reference workload's three parts (calibrate.ts). */
export const COMPONENTS = ['cpu', 'db', 'vector'] as const;
export type Component = (typeof COMPONENTS)[number];
export type ComponentMs = Record<Component, number>;

/**
 * The reference workload on the reference runner, each part's fastest of CALIBRATION_RUNS, in ms:
 * a fast GitHub runner (AMD EPYC 9V45), the one the nightly passed on (Oct 10 and 12).
 *
 * **Inferred, not yet measured on that runner**, because the workload is new: timed on an M1 Pro
 * (cpu 273.1, db 626.9, vector 401.8 ms, in a full local `ci-local.sh --only perf` run, 2026-10-17)
 * and divided by 1.42, how much slower that M1 Pro was than the 9V45 at the same fixed work in
 * the same run: the snapshot bench's full snapshot as owner, p50 453.5 ms against 327.2 and
 * 311.5 ms on Oct 10 and 12 (the bench is not scaled, and its p50 is steady). Re-pin from a 9V45
 * night's .tmp/perf/calibration.json (`measuredMs`, beside `machine`), and whenever calibrate.ts
 * changes (cpuWork()'s checksum guards its JavaScript part).
 */
export const REFERENCE_MS: ComponentMs = { cpu: 192.3, db: 441.5, vector: 283.0 };

/** Past this the run isn't evidence of anything: the limits stop growing and checks fail. */
export const MAX_FACTOR = 3;

export type Calibration = {
  /** This run's fastest time per part, ms. */
  measuredMs: ComponentMs;
  referenceMs: ComponentMs;
  /** measured / reference per part. */
  ratios: ComponentMs;
  /** The geometric mean of the ratios, before clamping. */
  raw: number;
  /** What the limits are multiplied by: raw, clamped to [1, MAX_FACTOR], two decimals. */
  factor: number;
  machine?: string;
};

const round = (n: number, places: number) => {
  const p = 10 ** places;
  return Math.round(n * p) / p;
};

/** The speed factor from this run's timings. Throws on a missing or non-positive timing. */
export function calibrationOf(
  measuredMs: ComponentMs,
  referenceMs: ComponentMs = REFERENCE_MS,
  machine?: string,
): Calibration {
  for (const c of COMPONENTS) {
    for (const [what, v] of [
      ['measured', measuredMs[c]],
      ['reference', referenceMs[c]],
    ] as const) {
      if (!Number.isFinite(v) || v <= 0) throw new Error(`calibration: ${what} ${c} is ${v}`);
    }
  }
  const ratios = Object.fromEntries(
    COMPONENTS.map((c) => [c, round(measuredMs[c] / referenceMs[c], 3)]),
  ) as ComponentMs;
  // Geometric mean: each part counts the same, whatever its length in ms.
  const raw = Math.exp(
    COMPONENTS.reduce((sum, c) => sum + Math.log(measuredMs[c] / referenceMs[c]), 0) /
      COMPONENTS.length,
  );
  const factor = round(Math.min(MAX_FACTOR, Math.max(1, raw)), 2);
  return {
    measuredMs,
    referenceMs,
    ratios,
    raw: round(raw, 3),
    factor,
    ...(machine ? { machine } : {}),
  };
}

/** A millisecond limit on this runner: `baseMs` × the factor (never below 1), to 0.1 ms. */
export function scaledLimit(baseMs: number, factor: number): number {
  return round(baseMs * Math.min(MAX_FACTOR, Math.max(1, factor)), 1);
}

export type Verdict = {
  measuredMs: number;
  limitMs: number;
  factor: number;
  scaledLimitMs: number;
  pass: boolean;
  message: string;
};

/** One check: `measuredMs` against `baseMs` scaled by `factor`. */
export function judge(name: string, measuredMs: number, baseMs: number, factor: number): Verdict {
  const scaledLimitMs = scaledLimit(baseMs, factor);
  return {
    measuredMs,
    limitMs: baseMs,
    factor,
    scaledLimitMs,
    pass: measuredMs < scaledLimitMs,
    message: `${name}: ${measuredMs} ms against ${baseMs} ms × ${factor} (runner speed) = ${scaledLimitMs} ms`,
  };
}
