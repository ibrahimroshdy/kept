import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { PGBOSS_SCHEMA } from './install.js';

// Failed jobs (D166): a job that exhausted its retries stays in pg-boss's table in state
// `failed` until its retention ends. Instance admins see them (GET /api/v1/admin/jobs/failed),
// and retry or discard each one. Reading is plain SQL as kept_system; retry and discard go
// through pg-boss itself, so its own bookkeeping (queue counts, retry state) stays right.
//
// A job's `data` is never shown: it names what the job works on (ids), which is tenant
// information an instance admin has no business reading (D164). The error message is shown.

export type FailedJob = {
  id: string;
  name: string;
  /** The last attempt's error message, cut to 500 characters. */
  error: string | null;
  /** Attempts made, the first included. */
  attempts: number;
  createdAt: Date;
  failedAt: Date;
};

export type FailedPage = { jobs: FailedJob[]; next: [string, string] | null };

export type JobAdmin = {
  /** Newest failure first. `after` is the last row's [failedAt ISO, id] of the previous page. */
  listFailed: (opts: { limit: number; after?: [string, string] | null }) => Promise<FailedPage>;
  /** The failed job, or null when there is no failed job with this id. */
  findFailed: (id: string) => Promise<FailedJob | null>;
  /** Puts a failed job back in the queue for one more attempt. False if it isn't failed (any
   * more). */
  retry: (id: string) => Promise<boolean>;
  /** Deletes a failed job. False if it isn't failed (any more). */
  discard: (id: string) => Promise<boolean>;
  /** How many jobs failed for good since `since` (the status page's last day, step 8 T10). */
  countFailedSince?: (since: Date) => Promise<number>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  name: string;
  error: string | null;
  retry_count: number;
  created_on: Date;
  completed_on: Date | null;
};

const COLUMNS = `id, name, left(output->>'message', 500) AS error, retry_count, created_on,
                 completed_on`;

function toJob(r: Row): FailedJob {
  return {
    id: r.id,
    name: r.name,
    error: r.error,
    attempts: r.retry_count + 1,
    createdAt: r.created_on,
    failedAt: r.completed_on ?? r.created_on,
  };
}

/** Failed-job administration on a started pg-boss and a kept_system pool. */
export function jobAdmin(boss: PgBoss, system: pg.Pool): JobAdmin {
  const findFailed = async (id: string): Promise<FailedJob | null> => {
    if (!UUID.test(id)) return null;
    const { rows } = await system.query<Row>(
      `SELECT ${COLUMNS} FROM ${PGBOSS_SCHEMA}.job WHERE id = $1 AND state = 'failed'`,
      [id],
    );
    return rows[0] ? toJob(rows[0]) : null;
  };

  return {
    listFailed: async ({ limit, after }) => {
      const { rows } = await system.query<Row>(
        `SELECT ${COLUMNS} FROM ${PGBOSS_SCHEMA}.job
          WHERE state = 'failed'
            AND ($1::timestamptz IS NULL
                 OR (coalesce(completed_on, created_on), id) < ($1::timestamptz, $2::uuid))
          ORDER BY coalesce(completed_on, created_on) DESC, id DESC
          LIMIT $3`,
        [after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      const jobs = rows.slice(0, limit).map(toJob);
      const last = jobs.at(-1);
      return {
        jobs,
        next: rows.length > limit && last ? [last.failedAt.toISOString(), last.id] : null,
      };
    },
    findFailed,
    countFailedSince: async (since) => {
      const { rows } = await system.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${PGBOSS_SCHEMA}.job
          WHERE state = 'failed' AND coalesce(completed_on, created_on) >= $1`,
        [since],
      );
      return rows[0]?.n ?? 0;
    },
    retry: async (id) => {
      const job = await findFailed(id);
      if (!job) return false;
      await boss.retry(job.name, job.id);
      return true;
    },
    discard: async (id) => {
      const job = await findFailed(id);
      if (!job) return false;
      await boss.deleteJob(job.name, job.id);
      return true;
    },
  };
}
