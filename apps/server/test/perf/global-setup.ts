import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { packageRoot } from '../../src/package-root.js';
import { measureCalibration } from './calibrate.js';
import type { Calibration } from './calibration.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The runner's speed for this perf run (test/perf/calibration.ts; issue #159). */
    keptPerfCalibration: Calibration;
  }
}

const SUPERUSER_URL = 'postgres://postgres:postgres@localhost:5452/postgres';

// The perf run's second global setup (vitest.perf.config.ts), after test/global-setup.ts: times
// the reference workload once, before any check, hands it to every file and writes it beside the
// checks' figures (.tmp/perf/calibration.json).
export async function setup(project: TestProject): Promise<void> {
  const calibration = await measureCalibration(SUPERUSER_URL);
  project.provide('keptPerfCalibration', calibration);
  const dir = path.join(packageRoot(), '../../.tmp/perf');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'calibration.json');
  writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), calibration }, null, 2)}\n`,
  );
  console.log(`perf calibration: ${JSON.stringify(calibration)} → ${file}`);
}
