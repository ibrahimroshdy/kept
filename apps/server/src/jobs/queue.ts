import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { sendInTx, sendTenantJob } from './boss.js';
import { JOB_POLICIES, queueOptions } from './policies.js';

// The request side of jobs (D94): a route enqueues on its own transaction, so the job exists only
// if the write it follows commits. kept_app may only send (jobs/install.ts); kept_system works.

/** Queues a request may send to. Each handler re-derives what it may touch from the database,
 * never from `data` (the rule in jobs/boss.ts). */
export const REQUEST_QUEUES = [
  'notify-owner-new-member',
  'send-invite-mail',
  'reindex',
  // Step 3 (T9): AI cap and rejected-key notices, sent by the AI runtime's hooks (ai/notices.ts).
  'ai-notice',
  // Step 4 (T2): a channel's test send from Settings → Me → Notifications (a mail or a push, and
  // a webhook); the scan sends the reminders themselves.
  'reminder-deliver',
  'channel-webhook',
  // Step 6 (T2): a write's webhook fan-out, sent by audited() in the write's transaction (T15).
  // A system job: it reads the location's hooks and writes deliveries as kept_system.
  'webhook-fanout',
  // Step 6 (T16, D180): the instance AI provider's change notice, sent by PUT
  // /api/v1/ai/providers/instance for its own audit event (notices/transparency.ts).
  'transparency-notice',
  // Step 6 (T14, D207): the embeddings backfill on demand, sent by the admin's source switch
  // (embeddings/routes.ts); it also runs hourly. A system job: it embeds every location's backlog.
  'embed-backfill',
  // Step 8 (T10): Admin → Backups' "Run now", `{kind: 'manual', runId}`. A system job: the
  // worker's backup runs it as kept_owner, re-reading the settings; the data holds no secret.
  'backup',
] as const;
export type RequestQueue = (typeof REQUEST_QUEUES)[number];

/** Queues a request sends *tenant* jobs to (step 3, T2): the handler runs in the sender's scope,
 * which sendTenantJob() takes from the sending transaction, never from `data` (jobs/boss.ts). */
export const TENANT_REQUEST_QUEUES = [
  'extract',
  'import-csv',
  'pdf-text',
  'report',
  // Step 4 (T18): a claim pack, built in its requester's scope like the report.
  'claim-pack',
  // Step 7 (T2): a location export, the two archive imports and alias enrichment, each in its
  // requester's scope; the job re-reads its run under their row-level security (D180).
  'export',
  'import-homebox',
  'import-kept',
  'enrich-aliases',
  // Step 6 (T2): an assistant turn (T13, D166) and a thing's embedding after an edit (T14), each
  // in the asker's or editor's scope.
  'assistant-turn',
  'embed-thing',
] as const;
export type TenantRequestQueue = (typeof TENANT_REQUEST_QUEUES)[number];

/** Deduplication for a send (pg-boss's debounce: one job per key per slot of `singletonSeconds`;
 * a send whose slot is taken goes to the next slot, so a trailing job always follows the last
 * send). Works on a standard queue. */
export type SendDedupe = {
  singletonKey: string;
  singletonSeconds: number;
  /** Seconds to wait before the job may run: a debounce that lets more work arrive first (a
   * receipt's later pages, plan Q13). */
  startAfter?: number;
};

export type JobQueue = {
  send: (
    client: pg.ClientBase,
    name: RequestQueue,
    data: object,
    dedupe?: SendDedupe,
  ) => Promise<void>;
  /** Sends a tenant job on a scoped transaction (withScope's `client`): it runs as the user
   * whose scope that transaction has. */
  sendTenant: (
    client: pg.ClientBase,
    name: TenantRequestQueue,
    data: object,
    dedupe?: SendDedupe,
  ) => Promise<void>;
  /** Moves a system job's schedule (a cron in UTC): Admin → Backups' nightly time (step 8). The
   * schedule lives in pg-boss's tables, so the worker's cron follows it without a restart. */
  reschedule?: (name: RequestQueue, cron: string) => Promise<void>;
};

/** A JobQueue on a started pg-boss instance (a kept_system login). */
export function bossQueue(boss: PgBoss): JobQueue {
  return {
    send: async (client, name, data, dedupe) => {
      await sendInTx(
        boss,
        client,
        name,
        data,
        dedupe ? { ...dedupe, singletonNextSlot: true } : {},
      );
    },
    sendTenant: async (client, name, data, dedupe) => {
      await sendTenantJob(
        boss,
        client,
        name,
        data,
        dedupe ? { ...dedupe, singletonNextSlot: true } : {},
      );
    },
    reschedule: async (name, cron) => {
      await boss.schedule(name, cron, null, { tz: 'UTC' });
    },
  };
}

/** Creates the request queues with their policies (idempotent), so a web-only process can send
 * before any worker has started, and a job it sends carries the policy of its type. */
export async function createRequestQueues(boss: PgBoss): Promise<void> {
  for (const name of [...REQUEST_QUEUES, ...TENANT_REQUEST_QUEUES]) {
    const options = queueOptions(JOB_POLICIES[name]);
    await boss.createQueue(name, options);
    await boss.updateQueue(name, options);
  }
}
