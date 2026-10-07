import { afterAll, describe, expect, inject, it, vi } from 'vitest';
import { templateDbName, testDb, workerDbName } from './db.js';
import { leaveMarker, markerLeftBy } from './leftover.js';

// harness.test.ts and this file each leave a marker table behind. Whichever runs second on a
// worker checks for the other's; the last test below makes the check deterministic.
describe('template database, seen from a second file', () => {
  it('starts on a clone with nothing another file on this worker left behind', async () => {
    expect(await markerLeftBy(await testDb())).toEqual([]);
  });

  it('names worker databases apart: per run, per worker, never the template', () => {
    const runId = inject('keptRunId');
    expect(runId).toMatch(/^[a-z0-9]+$/);
    const names = new Set([
      templateDbName(runId),
      workerDbName(runId, '1'),
      workerDbName(runId, '2'),
      workerDbName(`${runId}x`, '1'),
    ]);
    expect(names.size).toBe(4);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(63);
  });

  it('the next file on this worker gets a fresh clone, not what this one left', async () => {
    const db = await testDb();
    await leaveMarker(db, 'harness-second-file.test.ts');
    expect(await markerLeftBy(db)).toEqual(['harness-second-file.test.ts']);

    // A new module instance is exactly what the next test file on this worker starts with.
    vi.resetModules();
    const next = (await import('./db.js')) as typeof import('./db.js');
    try {
      const nextDb = await next.testDb();
      expect(nextDb.dbName).toBe(db.dbName);
      expect(await markerLeftBy(nextDb)).toEqual([]);
    } finally {
      await next.closeTestDbs();
    }
    // Cloning is the slow part, and slower still when two runs share the server.
  }, 30_000);
});

afterAll(async () => {
  await leaveMarker(await testDb(), 'harness-second-file.test.ts');
});
