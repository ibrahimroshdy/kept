import type pg from 'pg';
import { isUndeliverableEmail } from '../auth/emails.js';
import type { Keyring, Sealed } from '../crypto/envelope.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition, type JobMeta } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import type { Mailer } from '../mail/mailer.js';
import {
  type OccurrenceForWebhook,
  openWebhookConfig,
  postWebhook,
  reminderEnvelope,
  type WebhookFetch,
  webhookAllowsPrivate,
} from './webhook.js';

// The channels' own jobs (D30; plan T15), aggregated by jobs/household.ts.
//
// `channel-webhook` sends one reminder to one webhook channel: the §2.6 envelope, signed, 10
// attempts over about 24 hours (jobs/policies.ts shows the arithmetic). Its data names a
// delivery, `{occurrenceId, userId, channelId}`; whether to send is read from the database
// (jobs/boss.ts's rule): the delivery row must exist, the channel must be that person's webhook,
// and the occurrence still open. A failure throws, so pg-boss tries again; the last failure
// doesn't: it marks the channel `failing_since`, the delivery `failed`, and mails the person once
// (a webhook's failure never fails the scan, which only queued it; L112).

type Log = Pick<SystemJobDeps['log'], 'info' | 'error'>;

export type WebhookJobDeps = {
  pools: Pick<Pools, 'system' | 'auth'>;
  mailer: Mailer;
  publicUrl: string;
  /** The keyring that opens the channel's sealed config. */
  keyring: () => Keyring;
  log?: Log;
  /** Tests: how the request leaves the process. */
  fetchFor?: WebhookFetch;
};

export type WebhookJobData = { occurrenceId: string; userId: string; channelId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWebhookJob(raw: unknown): WebhookJobData | null {
  const d = (raw ?? {}) as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
  return ok(d.occurrenceId) && ok(d.userId) && ok(d.channelId)
    ? { occurrenceId: d.occurrenceId, userId: d.userId, channelId: d.channelId }
    : null;
}

type Target = OccurrenceForWebhook & {
  state: string;
  config_ciphertext: Sealed;
  label: string | null;
  display_host: string | null;
};

async function targetOf(client: pg.ClientBase, d: WebhookJobData): Promise<Target | null> {
  const { rows } = await client.query<Target>(
    `SELECT o.id, o.location_id, o.thing_id, o.place_id, o.kind, o.source_type,
            o.due_on::text AS due_on, o.created_at, o.state,
            c.config_ciphertext, c.label, c.display_host
       FROM public.reminder_deliveries d
       JOIN public.reminder_occurrences o ON o.id = d.occurrence_id
       JOIN public.notification_channels c ON c.id = d.channel_id
      WHERE d.occurrence_id = $1 AND d.user_id = $2 AND d.channel_id = $3
        AND c.kind = 'webhook' AND c.user_id = $2`,
    [d.occurrenceId, d.userId, d.channelId],
  );
  return rows[0] ?? null;
}

/** What the job did. */
export type WebhookJobResult = 'sent' | 'failed' | 'nothing';

/**
 * Runs one `channel-webhook` job. `meta` says which attempt this is: without it (a direct call)
 * the attempt counts as the last.
 */
export async function runChannelWebhook(
  deps: WebhookJobDeps,
  raw: unknown,
  meta?: JobMeta,
): Promise<WebhookJobResult> {
  const data = parseWebhookJob(raw);
  if (!data) return 'nothing';
  const target = await withSystem(deps.pools.system, (_tx, c) => targetOf(c, data));
  if (target?.state !== 'open') return 'nothing';
  const config = openWebhookConfig(deps.keyring(), data.channelId, target.config_ciphertext);
  const res = await postWebhook(config, reminderEnvelope(deps.publicUrl, data.channelId, target), {
    allowPrivate: await webhookAllowsPrivate(deps.pools),
    ...(deps.fetchFor ? { fetchFor: deps.fetchFor } : {}),
  });
  const key = [data.occurrenceId, data.userId, data.channelId];
  if (res.ok) {
    await withSystem(deps.pools.system, async (_tx, c) => {
      await c.query(
        `UPDATE public.reminder_deliveries SET status = 'sent', sent_at = now(), error = NULL
          WHERE occurrence_id = $1 AND user_id = $2 AND channel_id = $3`,
        key,
      );
      await c.query(
        `UPDATE public.notification_channels
            SET verified_at = coalesce(verified_at, now()), failing_since = NULL
          WHERE id = $1`,
        [data.channelId],
      );
    });
    return 'sent';
  }
  const last = !meta || meta.retryCount >= meta.retryLimit;
  const newlyFailing = await withSystem(deps.pools.system, async (_tx, c) => {
    await c.query(
      `UPDATE public.reminder_deliveries SET status = CASE WHEN $4 THEN 'failed' ELSE status END,
              error = $5
        WHERE occurrence_id = $1 AND user_id = $2 AND channel_id = $3`,
      [...key, last, res.error],
    );
    if (!last) return false;
    const { rowCount } = await c.query(
      `UPDATE public.notification_channels SET failing_since = now()
        WHERE id = $1 AND failing_since IS NULL`,
      [data.channelId],
    );
    return (rowCount ?? 0) > 0;
  });
  if (!last) throw new Error(`webhook not delivered: ${res.error}`);
  if (newlyFailing) {
    const { rows } = await deps.pools.auth.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE id = $1',
      [data.userId],
    );
    const to = rows[0]?.email;
    if (to && !isUndeliverableEmail(to)) {
      await deps.mailer
        .send({ kind: 'channel-failing', to, label: target.label, host: target.display_host })
        .catch((err: unknown) => deps.log?.error({ err }, 'webhook failure notice not mailed'));
    }
  }
  deps.log?.info(
    { channelId: data.channelId, error: res.error },
    'webhook failed its last attempt',
  );
  return 'failed';
}

export function notifyJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'channel-webhook',
      kind: 'system',
      policy: JOB_POLICIES['channel-webhook'],
      handler: async (data, meta) => {
        const keys = deps.secretKeys;
        if (!keys) throw new Error('channel-webhook: this worker has no secret keys');
        await runChannelWebhook(
          {
            pools: deps.pools,
            mailer: deps.mailer,
            publicUrl: deps.publicUrl,
            keyring: () => keys.get().keyring,
            log: deps.log,
          },
          data,
          meta,
        );
      },
    }),
  ];
}
