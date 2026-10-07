// Database names for one test run. Every run gets its own id, so two runs at once (two
// terminals, an IDE runner beside `pnpm test`) never drop each other's template or worker
// databases. Postgres truncates identifiers at 63 bytes; these stay well under.

export function newRunId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

export function templateDbName(runId: string): string {
  return `kept_tpl_${runId}`;
}

export function workerDbName(runId: string, poolId: string): string {
  return `kept_test_${runId}_${poolId}`;
}

/** Matches every database a run creates, for teardown. */
export function runDbPattern(runId: string): string {
  return `kept\\_%\\_${runId}%`;
}
