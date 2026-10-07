import { createRequire } from 'node:module';
import type pg from 'pg';
import { getConstructionPlans, getMigrationPlans } from 'pg-boss';

export const PGBOSS_SCHEMA = 'pgboss';

/** The pg-boss schema version the installed package expects (its package.json `pgboss.schema`). */
export function pgBossSchemaVersion(): number {
  const pkg = createRequire(import.meta.url)('pg-boss/package.json') as {
    pgboss?: { schema?: unknown };
  };
  const version = pkg.pgboss?.schema;
  if (typeof version !== 'number') throw new Error('pg-boss package.json has no pgboss.schema');
  return version;
}

// §7.14, D190: kept_app may only *send* jobs (inside its own request transaction); kept_system
// runs the workers and maintenance. Found by running send()/work() under each role (spike S1):
// - send() as kept_app inserts into pgboss.job (routed to pgboss.job_common) and reads
//   pgboss.queue in the same INSERT … SELECT, calling pgboss.job_now().
// - kept_system needs DML on every pg-boss table (queue cache, fetch, complete, maintenance,
//   cron) but no DDL: Kept uses unpartitioned queues only, so create_queue() never creates a
//   table. `partition: true` queues would need CREATE on the schema and are not allowed.
// - Migration 0000 revokes EXECUTE on kept_owner's functions from PUBLIC (default privileges),
//   so pg-boss's functions are granted by name: all of them to kept_system, job_now() to kept_app.
// - kept_app's INSERT is limited to the columns send() writes (pg-boss's `insertJobs` plan in
//   plans.js, public path, `slots: false`), so a request can't forge a job's state, output,
//   start/finish times or retry count (Phase B review, item 4). It can still choose the data and
//   options a sender chooses; see the rule in boss.ts. RETURNING needs SELECT on id and
//   start_after. A pg-boss upgrade that writes another column shows up as a permission error in
//   boss.test.ts, not silently.
export const SEND_COLUMNS = [
  'id',
  'name',
  'data',
  'priority',
  'start_after',
  'created_on',
  'singleton_key',
  'singleton_on',
  'group_id',
  'group_tier',
  'expire_seconds',
  'deletion_seconds',
  'keep_until',
  'retry_limit',
  'retry_delay',
  'retry_backoff',
  'retry_delay_max',
  'policy',
  'dead_letter',
  'heartbeat_seconds',
  'blocked',
  'blocking',
  'pending_dependencies',
] as const;

const GRANTS = `
GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO kept_app, kept_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO kept_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${PGBOSS_SCHEMA} TO kept_system;
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA ${PGBOSS_SCHEMA}
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kept_system;
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA ${PGBOSS_SCHEMA}
  GRANT USAGE, SELECT ON SEQUENCES TO kept_system;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO kept_system;
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA ${PGBOSS_SCHEMA}
  GRANT EXECUTE ON FUNCTIONS TO kept_system;
GRANT EXECUTE ON FUNCTION ${PGBOSS_SCHEMA}.job_now() TO kept_app;
REVOKE INSERT ON ${PGBOSS_SCHEMA}.job_common FROM kept_app;
GRANT INSERT (${SEND_COLUMNS.join(', ')}), SELECT (id, start_after)
  ON ${PGBOSS_SCHEMA}.job_common TO kept_app;
GRANT SELECT ON ${PGBOSS_SCHEMA}.queue TO kept_app;
`;

/**
 * Installs or upgrades pg-boss's schema as kept_owner (§7.14), using pg-boss's own exported SQL,
 * then (re)applies Kept's grants. Runs from `runMigrations`, inside Kept's advisory lock; the
 * plans also take pg-boss's own advisory lock. The runtime instances start with `migrate: false`.
 */
export async function installPgBoss(client: pg.ClientBase): Promise<void> {
  const target = pgBossSchemaVersion();
  const { rows } = await client.query<{ reg: string | null }>(
    `SELECT to_regclass('${PGBOSS_SCHEMA}.version')::text AS reg`,
  );
  if (!rows[0]?.reg) {
    await client.query(getConstructionPlans(PGBOSS_SCHEMA));
  } else {
    const current = await client.query<{ version: number }>(
      `SELECT version FROM ${PGBOSS_SCHEMA}.version`,
    );
    const version = Number(current.rows[0]?.version);
    if (version > target) {
      throw new Error(
        `pg-boss schema is at version ${version}, newer than this build expects (${target})`,
      );
    }
    if (version < target) {
      // Untested until pg-boss ships its next schema version. getMigrationPlans() inlines the
      // async index builds after its COMMIT; if one of them is `CONCURRENTLY`, it can't share a
      // simple-query batch, and this needs splitting. See docs/spikes/2026-09-26-s1.md.
      await client.query(getMigrationPlans(PGBOSS_SCHEMA, version));
    }
  }
  await client.query(GRANTS);
}
