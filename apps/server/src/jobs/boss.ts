import type pg from 'pg';
import { type ConstructorOptions, type Db, PgBoss, type SendOptions } from 'pg-boss';
import type { Pools } from '../db/pools.js';
import { type Scope, ScopeError, type Tx, withScope } from '../db/scope.js';
import { PGBOSS_SCHEMA } from './install.js';
import { type JobPolicy, queueOptions } from './policies.js';

export type BossOptions = {
  /** A `kept_system` login (KEPT_SYSTEM_DATABASE_URL). Never the owner (§7.1, §7.14). */
  connectionString: string;
  application_name?: string;
  /** Pool size for pg-boss's own pool. */
  max?: number;
  /** Maintenance and cron. Off in a `web`-only process, which only sends. */
  supervise?: boolean;
  schedule?: boolean;
};

/**
 * pg-boss running as kept_system with its own migrations off (§7.14, D190). The schema is
 * installed by `kept migrate` (jobs/install.ts); `start()` only checks the version matches.
 * `reindex` is off because kept_system doesn't own the job indexes; rebuilding them is an
 * operator task (`getReindexCommands()`), not something the serving role can do.
 *
 * Even a process that only sends must `start()` its instance: send() reads pg-boss's queue
 * cache, which start() initialises.
 */
export function createBoss(opts: BossOptions): PgBoss {
  const config: ConstructorOptions = {
    connectionString: opts.connectionString,
    application_name: opts.application_name ?? 'kept-jobs',
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    reindex: false,
    supervise: opts.supervise ?? true,
    schedule: opts.schedule ?? true,
  };
  if (opts.max !== undefined) config.max = opts.max;
  return new PgBoss(config);
}

/** Adapts a pg client that is inside a transaction to pg-boss's `db` option. */
export function clientDb(client: pg.ClientBase): Db {
  return {
    executeSql: async (text, values) => {
      const result = await client.query(text, values as unknown[] | undefined);
      return { rows: result.rows };
    },
  };
}

/**
 * Enqueue a job on the caller's transaction (D94): the job exists only if that transaction
 * commits. `client` is the kept_app (or kept_system) connection `withScope()`/`withSystem()`
 * hands to its callback; kept_app may only INSERT the columns send() writes into
 * pgboss.job_common (jobs/install.ts).
 *
 * **Rule for every job handler (Phase B review, item 4):** a job's `data` is written by a
 * request, so whatever kept_app can do, a job can claim. Handlers run as kept_system, whose
 * `system_all` policies see every tenant's rows in the tables it is allowed (migration 0006), so a
 * handler must never take its scope (which user, location or rows it may touch) from `data` on
 * trust. `data` names *what* to work on; the handler re-derives
 * *whether* that is allowed from the database (e.g. the row's owner), or the job is enqueued only
 * by kept_system itself for a queue kept_app never sends to.
 */
export function sendInTx(
  boss: PgBoss,
  client: pg.ClientBase,
  name: string,
  data: object | null,
  options: Omit<SendOptions, 'db'> = {},
): Promise<string | null> {
  return boss.send(name, data, { ...options, db: clientDb(client) });
}

// ---------------------------------------------------------------------------------------------
// The job registry (task 24; D166, engineering spec §3.1b, §7.1).
//
// Every job type is declared with defineJob(): its name, its kind, an optional schedule, and its
// policy (jobs/policies.ts). The kind says whose rights the handler has (§7.1):
// - `system`: cross-tenant work as kept_system. The handler gets the job's data and nothing
//   else; it reaches the database through withSystem() on the system pool (or the auth pool for
//   schema auth), never kept_app. Only a system job may be scheduled: a schedule has no user.
// - `tenant`: work for one person, re-assuming the scope of the request that sent it. The
//   payload carries `userId` (and `mfa`), taken from the sending transaction itself by
//   sendTenantJob(), never from the caller; the handler runs inside withScope() on kept_app, so
//   row-level security holds it to that person's rows exactly as it held the request.
// ---------------------------------------------------------------------------------------------

type JobBase = { name: string; policy: JobPolicy };

export type SystemJob = JobBase & {
  kind: 'system';
  /** A cron expression in UTC. The scheduled job carries no data. */
  schedule?: string;
  /** `meta` is pg-boss's facts about the run, when there is a run (a job with its own retry
   * schedule acts on its last attempt: step 4's `channel-webhook`). */
  handler: (data: unknown, meta?: JobMeta) => Promise<void>;
};

export type TenantJobContext = {
  /** What the sender put in, beside the scope. */
  data: unknown;
  scope: Scope;
  tx: Tx;
  client: pg.PoolClient;
  /** pg-boss's own facts about this run (absent when a test calls runJob() without them): the
   * job id (a ledger row's request id, T10) and how many retries are spent and allowed. */
  job?: JobMeta;
};

/** What a handler may know about the run itself. */
export type JobMeta = { id: string; retryCount: number; retryLimit: number };

export type TenantJob = JobBase & {
  kind: 'tenant';
  handler: (ctx: TenantJobContext) => Promise<void>;
};

export type JobDefinition = SystemJob | TenantJob;

const JOB_NAME = /^[a-z][a-z0-9-]{1,62}$/;

/** Checks a job declaration once, where it is written. */
export function defineJob<T extends JobDefinition>(job: T): T {
  if (!JOB_NAME.test(job.name)) throw new Error(`job name ${job.name}: lowercase and dashes`);
  if (job.kind === 'tenant' && 'schedule' in job) {
    throw new Error(`job ${job.name}: a tenant job can't be scheduled (a schedule has no user)`);
  }
  const { retryLimit, retryDelay, expireInSeconds } = job.policy;
  if (retryLimit < 0 || retryDelay < 0 || expireInSeconds < 1) {
    throw new Error(`job ${job.name}: invalid policy`);
  }
  return job;
}

/** What a tenant job's payload holds. */
export type TenantPayload = { userId: string; mfa: boolean; data: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Enqueues a tenant job on a scoped transaction (withScope's `client`). The user and the second
 * factor come from the transaction's own `app.user_id` and `app.mfa`, so the job re-assumes
 * exactly the scope the request had, whatever the caller passes as `data`.
 */
export async function sendTenantJob(
  boss: PgBoss,
  client: pg.ClientBase,
  name: string,
  data: object | null,
  options: Omit<SendOptions, 'db'> = {},
): Promise<string | null> {
  const { rows } = await client.query<{ user_id: string | null; mfa: string | null }>(
    `SELECT current_setting('app.user_id', true) AS user_id,
            current_setting('app.mfa', true) AS mfa`,
  );
  const userId = rows[0]?.user_id ?? '';
  if (!UUID.test(userId)) {
    throw new ScopeError('a tenant job is sent from inside withScope(), which names its user');
  }
  const payload: TenantPayload = { userId, mfa: rows[0]?.mfa === 'true', data };
  return sendInTx(boss, client, name, payload, options);
}

function tenantPayload(raw: unknown): TenantPayload {
  const p = (raw ?? {}) as Partial<TenantPayload>;
  if (typeof p.userId !== 'string' || !UUID.test(p.userId) || typeof p.mfa !== 'boolean') {
    // Fails the job for good (it lands in the failed list): a malformed scope never runs.
    throw new ScopeError('tenant job payload has no valid scope');
  }
  return { userId: p.userId, mfa: p.mfa, data: p.data ?? null };
}

export type RegisterOptions = {
  /** kept_app, for tenant jobs. */
  pools: Pick<Pools, 'app'>;
  /** How often an idle worker polls (pg-boss's default is 2 s). Tests poll faster. */
  pollingIntervalSeconds?: number;
};

/** Runs one job's handler with the rights its kind gives it. */
export async function runJob(
  job: JobDefinition,
  data: unknown,
  pools: Pick<Pools, 'app'>,
  meta?: JobMeta,
): Promise<void> {
  if (job.kind === 'system') {
    await job.handler(data, meta);
    return;
  }
  const payload = tenantPayload(data);
  const scope: Scope = { userId: payload.userId, mfa: payload.mfa };
  await withScope(pools.app, scope, (tx, client) =>
    job.handler({ data: payload.data, scope, tx, client, ...(meta ? { job: meta } : {}) }),
  );
}

/**
 * Creates each job's queue with its policy (and brings an existing queue's policy up to date),
 * schedules the system jobs that have a schedule, and starts a worker for each. Idempotent: every
 * worker process runs it at start.
 */
export async function registerJobs(
  boss: PgBoss,
  jobs: readonly JobDefinition[],
  opts: RegisterOptions,
): Promise<void> {
  const names = new Set<string>();
  for (const job of jobs) {
    if (names.has(job.name)) throw new Error(`job ${job.name} is registered twice`);
    names.add(job.name);
    const options = queueOptions(job.policy);
    await boss.createQueue(job.name, options);
    await boss.updateQueue(job.name, options);
    if (job.kind === 'system' && job.schedule) {
      await boss.schedule(job.name, job.schedule, null, { tz: 'UTC' });
    }
    const workOptions = {
      includeMetadata: true as const,
      ...(opts.pollingIntervalSeconds === undefined
        ? {}
        : { pollingIntervalSeconds: opts.pollingIntervalSeconds }),
    };
    await boss.work(job.name, workOptions, async (batch) => {
      for (const one of batch) {
        await runJob(job, one.data, opts.pools, {
          id: one.id,
          retryCount: one.retryCount,
          retryLimit: one.retryLimit,
        });
      }
    });
  }
}
