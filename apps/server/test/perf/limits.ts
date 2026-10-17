import { expect, inject } from 'vitest';
import { type Calibration, judge } from './calibration.js';

// The checks' limits on this runner (issue #159): each file's LIMITS are the reference runner's
// milliseconds; `under()` scales one by the run's speed factor (test/perf/global-setup.ts),
// records the verdict in the file's results (`limits`, beside the figures in its JSON) and fails
// with the factor and the scaled limit in the message.

/** This run's calibration, measured once before any file. */
export function calibration(): Calibration {
  return inject('keptPerfCalibration');
}

/** Asserts `measuredMs` is under `baseMs` × the runner's factor, and records the verdict. */
export function under(
  results: Record<string, unknown>,
  name: string,
  measuredMs: number,
  baseMs: number,
): void {
  const v = judge(name, measuredMs, baseMs, calibration().factor);
  const { message: _message, ...recorded } = v;
  results.limits = { ...(results.limits as Record<string, unknown> | undefined), [name]: recorded };
  expect(measuredMs, v.message).toBeLessThan(v.scaledLimitMs);
}
