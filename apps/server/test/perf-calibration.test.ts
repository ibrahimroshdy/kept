import { describe, expect, it } from 'vitest';
import { CPU_CHECKSUM, cpuWork } from './perf/calibrate.js';
import {
  type ComponentMs,
  calibrationOf,
  judge,
  MAX_FACTOR,
  REFERENCE_MS,
  scaledLimit,
} from './perf/calibration.js';

// The perf run's speed factor and scaled limits (test/perf/calibration.ts, issue #159), without
// the perf run: the arithmetic, and that a real regression still fails on any runner.

const REF: ComponentMs = { cpu: 200, db: 400, vector: 300 };
const times = (k: ComponentMs | number, ref = REF): ComponentMs =>
  typeof k === 'number'
    ? { cpu: ref.cpu * k, db: ref.db * k, vector: ref.vector * k }
    : { cpu: ref.cpu * k.cpu, db: ref.db * k.db, vector: ref.vector * k.vector };

// The nightly figures the issue is about (semantic search's p95 under §3.1's 300 ms): the fast
// runner on Oct 12 and a slow one on Oct 17, the same code. On the slow night the snapshot bench,
// which no limit here scales, ran its full snapshot at p50 523.6 ms against 311.5 ms: 1.68×. That
// stands in for the slow runner's reference work.
const SEARCH_LIMIT_MS = 300;
const FAST_NIGHT_SEARCH_P95 = 159.3;
const SLOW_NIGHT_SEARCH_P95 = 402.7;
const SLOW_RUNNER = 1.68;

describe('the runner speed factor', () => {
  it('is 1 on the reference runner', () => {
    const c = calibrationOf(REF, REF);
    expect(c.raw).toBe(1);
    expect(c.factor).toBe(1);
    expect(c.ratios).toEqual({ cpu: 1, db: 1, vector: 1 });
  });

  it('never goes below 1 on a faster runner', () => {
    const c = calibrationOf(times(0.6), REF);
    expect(c.raw).toBe(0.6);
    expect(c.factor).toBe(1);
  });

  it('is the geometric mean of the parts on a slower one', () => {
    expect(calibrationOf(times(1.6), REF).factor).toBe(1.6);
    // Vector arithmetic slowed most on the slow nights: (1.5 × 1.5 × 2.5)^(1/3).
    const c = calibrationOf(times({ cpu: 1.5, db: 1.5, vector: 2.5 }), REF);
    expect(c.ratios).toEqual({ cpu: 1.5, db: 1.5, vector: 2.5 });
    expect(c.factor).toBe(1.78);
  });

  it(`stops at ${MAX_FACTOR}`, () => {
    const c = calibrationOf(times(5), REF);
    expect(c.raw).toBe(5);
    expect(c.factor).toBe(MAX_FACTOR);
    expect(scaledLimit(100, 5)).toBe(100 * MAX_FACTOR);
  });

  it('refuses a missing or non-positive timing', () => {
    expect(() => calibrationOf({ ...REF, db: 0 }, REF)).toThrow(/measured db is 0/);
    expect(() => calibrationOf({ ...REF, cpu: Number.NaN }, REF)).toThrow(/measured cpu/);
    expect(() => calibrationOf(REF, { ...REF, vector: -1 })).toThrow(/reference vector/);
  });

  it('has a pinned reference for every part', () => {
    expect(() => calibrationOf(REFERENCE_MS)).not.toThrow();
  });

  it('runs the same workload everywhere (re-pin REFERENCE_MS when its checksum changes)', () => {
    expect(cpuWork()).toBe(CPU_CHECKSUM);
  });
});

describe('a scaled limit', () => {
  it('is the limit times the factor, to 0.1 ms', () => {
    expect(scaledLimit(300, 1)).toBe(300);
    expect(scaledLimit(110.4, 1.37)).toBe(151.2);
    expect(scaledLimit(300, 0.5)).toBe(300);
  });

  it('names the factor and the scaled limit when it fails', () => {
    const v = judge('searchSemanticP95Ms', 520, 300, 1.68);
    expect(v).toMatchObject({ limitMs: 300, factor: 1.68, scaledLimitMs: 504, pass: false });
    expect(v.message).toBe(
      'searchSemanticP95Ms: 520 ms against 300 ms × 1.68 (runner speed) = 504 ms',
    );
  });
});

describe('a 2× regression still fails', () => {
  it('on the reference runner (factor 1)', () => {
    const factor = calibrationOf(REF, REF).factor;
    expect(judge('search', FAST_NIGHT_SEARCH_P95, SEARCH_LIMIT_MS, factor).pass).toBe(true);
    expect(judge('search', FAST_NIGHT_SEARCH_P95 * 2, SEARCH_LIMIT_MS, factor).pass).toBe(false);
  });

  it('on a slow runner, whose reference work does not slow down with the code', () => {
    // The fixed limit failed the unchanged code on the slow night (the bug).
    expect(judge('search', SLOW_NIGHT_SEARCH_P95, SEARCH_LIMIT_MS, 1).pass).toBe(false);
    // Calibrated once per run: the regression is in search, so the reference work, and the
    // factor, are the same with or without it.
    const factor = calibrationOf(times(SLOW_RUNNER), REF).factor;
    expect(factor).toBe(SLOW_RUNNER);
    expect(judge('search', SLOW_NIGHT_SEARCH_P95, SEARCH_LIMIT_MS, factor).pass).toBe(true);
    expect(judge('search', SLOW_NIGHT_SEARCH_P95 * 2, SEARCH_LIMIT_MS, factor).pass).toBe(false);
  });
});
