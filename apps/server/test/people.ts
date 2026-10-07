import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { ensureAccount } from '../src/accounts/ensure-account.js';
import type { JobQueue } from '../src/jobs/queue.js';
import { type TestApp, type TestAppOptions, testApp } from './app.js';
import { signUp } from './auth.js';
import type { TestDb } from './db.js';
import { ownerTx } from './tenancy.js';

// People and requests for the route tests of tasks 19–21: signed-in users with their account
// (ensureAccount, task 18) and a cookie, and a small inject wrapper that speaks JSON.

export const PASSWORD = 'correct horse battery';

export type Person = { userId: string; email: string; cookie: string; personalLocationId: string };

/** Jobs sent by requests, recorded instead of queued (the notify job is tested on its own). */
export type RecordedJob = { name: string; data: object };

/** A schedule moved by a request (Admin → Backups' time), recorded instead of set in pg-boss. */
export type RecordedSchedule = { name: string; cron: string };

export function recordingQueue(sent: RecordedJob[], schedules?: RecordedSchedule[]): JobQueue {
  return {
    ...(schedules
      ? {
          reschedule: async (name: string, cron: string) => {
            schedules.push({ name, cron });
          },
        }
      : {}),
    send: async (_client: pg.ClientBase, name, data) => {
      sent.push({ name, data });
    },
    // Step 3's tenant jobs (extract, import-csv, pdf-text) are recorded the same way.
    sendTenant: async (_client: pg.ClientBase, name, data) => {
      sent.push({ name, data });
    },
  };
}

export async function peopleApp(
  db: TestDb,
  opts: TestAppOptions & { sent?: RecordedJob[]; schedules?: RecordedSchedule[] } = {},
): Promise<TestApp> {
  const { sent, schedules, ...rest } = opts;
  return testApp(db, { ...(sent ? { jobs: recordingQueue(sent, schedules) } : {}), ...rest });
}

export async function person(t: TestApp, db: TestDb, label: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.com`;
  const { userId, cookie } = await signUp(t.auth, email, PASSWORD);
  const { personalLocationId } = await ensureAccount(db.pools, userId);
  return { userId, email, cookie, personalLocationId };
}

export type Call = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  as?: { cookie: string } | null;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
};

let ipCounter = 0;
/** A fresh documentation-range address per call, so per-IP limits don't cross tests. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

export function call(t: TestApp, url: string, opts: Call = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { origin: t.publicUrl, ...opts.headers };
  if (opts.as) headers.cookie = opts.as.cookie;
  return t.app.inject({
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    url,
    headers,
    remoteAddress: opts.ip ?? freshIp(),
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
}

/** Adds `userId` to a location directly (kept_owner), for tests that need a member quickly. */
export function join(
  db: TestDb,
  locationId: string,
  userId: string,
  role: 'admin' | 'member' | 'viewer',
  expiresAt: Date | null = null,
): Promise<string> {
  return ownerTx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO public.memberships (location_id, user_id, role, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [locationId, userId, role, expiresAt],
    );
    return rows[0]?.id as string;
  });
}

/** The audit events of a location, oldest first (as kept_owner). */
export function auditOf(
  db: TestDb,
  locationId: string,
): Promise<{ action: string; actor_type: string; actor_id: string | null; diff: unknown }[]> {
  return ownerTx(db, async (c) => {
    const { rows } = await c.query(
      `SELECT action, actor_type, actor_id, diff FROM public.audit_events
        WHERE location_id = $1 ORDER BY at, id`,
      [locationId],
    );
    return rows;
  });
}

/** Runs the `send-invite-mail` jobs a request queued (invites/mail-job.ts), mailing into t.mail,
 * as the worker would. Removes them from `sent`. */
export async function mailQueuedInvites(
  t: TestApp,
  db: TestDb,
  sent: RecordedJob[],
): Promise<void> {
  const { sendInviteMail } = await import('../src/invites/mail-job.js');
  for (const job of sent.filter((j) => j.name === 'send-invite-mail')) {
    await sendInviteMail(
      {
        pools: db.pools,
        mailer: {
          send: async (m) => {
            t.mail.push(m);
          },
        },
        publicUrl: t.publicUrl,
      },
      job.data,
    );
  }
  sent.splice(0, sent.length, ...sent.filter((j) => j.name !== 'send-invite-mail'));
}
