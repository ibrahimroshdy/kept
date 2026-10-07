import { randomBytes } from 'node:crypto';
import { WEBHOOK_LIMITS, type WebhookPayload } from '@kept/shared';
import type pg from 'pg';
import { allowPrivateAddresses } from '../ai/runtime.js';
import { type AlertDeps, raiseAlert, resolveAlert } from '../alerts/alerts.js';
import { type Keyring, open, type Sealed } from '../crypto/envelope.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition, type JobMeta } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { postWebhook, type WebhookFetch } from '../notify/webhook.js';
import { auditEventIdOf, occurrenceIdOf, runWebhookFanout, WEBHOOK_EVENT_OF } from './fanout.js';
import { webhookAad } from './service.js';

// Location webhooks' jobs (D63, D110, D180; engineering spec §2.6, §3.1b; step-6 plan T15),
// aggregated by jobs/step6.ts. Both run as kept_system:
// - `webhook-fanout` {auditEventId}: sent by audited() in the write's transaction (fanout.ts),
//   or {occurrenceId}: sent by the reminder scan for `reminder.due`; one delivery row per active
//   hook taking the event, and a `webhook-deliver` for each.
// - `webhook-deliver` {deliveryId}: one signed, value-free POST. pg-boss retries a failure (10
//   attempts over about 24 hours, jobs/policies.ts shows the arithmetic); the last failure marks
//   the delivery `gave_up` and the hook `failing_since`, and a later success clears the mark.
//
// What is sent is read from the database, never from the job's data (jobs/boss.ts): the
// delivery row, the hook (through kept.webhook_secret(), which also hands over its sealed secret)
// and the audit event the delivery's id names. The payload is §2.6's: ids, the event, when, the
// actor and the changed fields' names. Never a value, a name or a note (D110): a receiver fetches
// the thing with its own token.
//
// Each POST goes through guardedFetch() (net/ssrf.ts, via notify/webhook.ts postWebhook):
// private addresses refused at connect time unless `ssrf_allow_private`, redirects refused, 10 s.
// At most WEBHOOK_LIMITS.perSecondPerLocation a second per location, per worker process.

export type DeliverDeps = {
  pools: Pick<Pools, 'system'>;
  /** The keyring that opens a hook's sealed secret. */
  keyring: () => Keyring;
  /** Tests: how the request leaves the process. */
  fetchFor?: WebhookFetch | undefined;
  /** Tests: the clock the pacing reads. */
  now?: (() => number) | undefined;
  /** The admin alert a hook raises when it starts failing (`webhook_failing`), resolved by its
   * next delivery. Absent: the hook is only marked. */
  alerts?: AlertDeps | undefined;
};

export type DeliveryResult = {
  outcome: 'delivered' | 'failed' | 'gave_up' | 'nothing';
  httpStatus: number | null;
};

type DeliveryRow = {
  id: string;
  location_id: string;
  webhook_id: string;
  event_id: string;
  event: string;
  status: string;
  attempts: number;
  created_at: Date;
};

type HookRow = {
  location_id: string;
  url: string;
  secret_ciphertext: Sealed;
  key_version: number;
  active: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTOR_TYPES = new Set(['user', 'token', 'system']);

/** The §2.6 payload for a delivery: from its audit event, or a ping's. Null when the event is
 * gone (pruned) or isn't a webhook event. */
async function payloadOf(client: pg.ClientBase, d: DeliveryRow): Promise<WebhookPayload | null> {
  if (d.event === 'ping') {
    return {
      id: d.event_id,
      event: 'ping',
      occurred_at: d.created_at.toISOString(),
      location_id: d.location_id,
      entity: { type: 'webhook', id: d.webhook_id },
      changed_fields: [],
      actor: { type: 'system', id: null },
    };
  }
  if (d.event === 'reminder.due') {
    // A reminder occurrence, not a write (fanout.ts): the occurrence's id and when it was
    // written, by the scan. Nothing of its kind, source or date.
    const occurrenceId = occurrenceIdOf(d.event_id);
    if (!occurrenceId) return null;
    const { rows } = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM public.reminder_occurrences WHERE id = $1 AND location_id = $2`,
      [occurrenceId, d.location_id],
    );
    const o = rows[0];
    if (!o) return null;
    return {
      id: d.event_id,
      event: 'reminder.due',
      occurred_at: o.created_at.toISOString(),
      location_id: d.location_id,
      entity: { type: 'reminder', id: occurrenceId },
      changed_fields: [],
      actor: { type: 'system', id: null },
    };
  }
  const auditId = auditEventIdOf(d.event_id);
  if (!auditId) return null;
  const { rows } = await client.query<{
    at: Date;
    action: string;
    entity_type: string;
    entity_id: string | null;
    actor_type: string;
    actor_id: string | null;
    fields: string[] | null;
  }>(
    `SELECT at, action, entity_type, entity_id, actor_type, actor_id,
            ARRAY(SELECT jsonb_object_keys(diff) ORDER BY 1) AS fields
       FROM public.audit_events WHERE id = $1 AND location_id = $2`,
    [auditId, d.location_id],
  );
  const e = rows[0];
  if (!e?.entity_id || WEBHOOK_EVENT_OF[e.action] !== d.event) return null;
  return {
    id: d.event_id,
    event: d.event as WebhookPayload['event'],
    occurred_at: e.at.toISOString(),
    location_id: d.location_id,
    entity: { type: e.entity_type === 'meter_reading' ? 'reading' : 'thing', id: e.entity_id },
    changed_fields: e.fields ?? [],
    actor: ACTOR_TYPES.has(e.actor_type)
      ? { type: e.actor_type as 'user' | 'token' | 'system', id: e.actor_id }
      : { type: 'system', id: null },
  };
}

// At most perSecondPerLocation POSTs a second per location, in this process.
const recent = new Map<string, number[]>();

async function pace(locationId: string, now: () => number): Promise<void> {
  for (;;) {
    const t = now();
    const list = (recent.get(locationId) ?? []).filter((x) => t - x < 1000);
    if (list.length < WEBHOOK_LIMITS.perSecondPerLocation) {
      list.push(t);
      recent.set(locationId, list);
      return;
    }
    recent.set(locationId, list);
    await new Promise((r) => setTimeout(r, Math.max(1, 1000 - (t - (list[0] as number)) + 1)));
  }
}

/** Roughly when pg-boss tries again after a failure at retry `c` (jobs/policies.ts: d·2^c·(1+U),
 * U in [0, 1), so on average d·2^c·1.5). An estimate, for the deliveries list. */
function nextAttemptEstimate(retryCount: number): Date {
  const d = JOB_POLICIES['webhook-deliver'].retryDelay;
  return new Date(Date.now() + d * 2 ** retryCount * 1.5 * 1000);
}

/**
 * Runs one `webhook-deliver` job. `meta` says which attempt this is: without it (a direct call,
 * the test ping) the attempt counts as the last. A failure that isn't the last throws, so
 * pg-boss tries again.
 */
export async function runWebhookDelivery(
  deps: DeliverDeps,
  raw: unknown,
  meta?: JobMeta,
): Promise<DeliveryResult> {
  const deliveryId = (raw as { deliveryId?: unknown } | null)?.deliveryId;
  if (typeof deliveryId !== 'string' || !UUID.test(deliveryId)) {
    return { outcome: 'nothing', httpStatus: null };
  }
  const found = await withSystem(deps.pools.system, async (_tx, c) => {
    const { rows } = await c.query<DeliveryRow>(
      `SELECT id, location_id, webhook_id, event_id, event, status, attempts, created_at
         FROM public.webhook_deliveries WHERE id = $1`,
      [deliveryId],
    );
    const d = rows[0];
    if (!d || d.status === 'delivered' || d.status === 'gave_up') return null;
    const hook = (await c.query<HookRow>('SELECT * FROM kept.webhook_secret($1)', [d.webhook_id]))
      .rows[0];
    if (!hook || hook.location_id !== d.location_id) return null;
    const payload = hook.active ? await payloadOf(c, d) : null;
    if (!payload) {
      // The hook was turned off (by an admin, or because its creator lost the role, D180), or
      // the event is gone: nothing will ever be sent for this delivery.
      await c.query(
        `UPDATE public.webhook_deliveries SET status = 'gave_up', next_attempt_at = NULL,
                updated_at = now()
          WHERE id = $1`,
        [d.id],
      );
      return null;
    }
    return { d, hook, payload };
  });
  if (!found) return { outcome: 'nothing', httpStatus: null };
  const { d, hook, payload } = found;

  const secret = open(deps.keyring(), hook.secret_ciphertext, webhookAad(d.webhook_id)).toString(
    'utf8',
  );
  await pace(d.location_id, deps.now ?? Date.now);
  const res = await postWebhook({ url: hook.url, secret }, payload, {
    allowPrivate: await allowPrivateAddresses(deps.pools),
    ...(deps.fetchFor ? { fetchFor: deps.fetchFor } : {}),
  });
  const httpStatus = res.status ?? null;
  const ping = d.event === 'ping';
  const last = ping || !meta || meta.retryCount >= meta.retryLimit;
  const outcome: DeliveryResult['outcome'] = res.ok
    ? 'delivered'
    : last && !ping
      ? 'gave_up'
      : 'failed';
  const marked = await withSystem(deps.pools.system, async (_tx, c) => {
    await c.query(
      `UPDATE public.webhook_deliveries
          SET status = $2, attempts = least(attempts + 1, 50), http_status = $3,
              next_attempt_at = $4, updated_at = now()
        WHERE id = $1`,
      [
        d.id,
        outcome,
        httpStatus,
        outcome === 'failed' && !ping ? nextAttemptEstimate(meta?.retryCount ?? 0) : null,
      ],
    );
    if (ping) return null;
    if (outcome === 'delivered') {
      const { rowCount } = await c.query(
        `UPDATE public.webhooks SET failing_since = NULL
          WHERE id = $1 AND failing_since IS NOT NULL`,
        [d.webhook_id],
      );
      return rowCount ? ('recovered' as const) : null;
    }
    if (outcome === 'gave_up') {
      const { rows } = await c.query<{ failing_since: Date }>(
        `UPDATE public.webhooks SET failing_since = now() WHERE id = $1 AND failing_since IS NULL
         RETURNING failing_since`,
        [d.webhook_id],
      );
      return rows[0] ? { since: rows[0].failing_since } : null;
    }
    return null;
  });
  // The instance admins hear once a hook starts failing (step 6): one alert per hook, no URL or
  // location name in it (tenant data), resolved when it delivers again.
  if (marked && deps.alerts) {
    const key = `webhook_failing:${d.webhook_id}`;
    if (marked === 'recovered') await resolveAlert(deps.alerts.pools, key);
    else {
      await raiseAlert(deps.alerts, 'webhook_failing', key, {
        webhookId: d.webhook_id,
        locationId: d.location_id,
        since: marked.since.toISOString(),
      });
    }
  }
  if (outcome === 'failed' && !ping) {
    throw new Error(`webhook not delivered: ${res.ok ? 'ok' : res.error}`);
  }
  return { outcome, httpStatus };
}

/**
 * POST /api/v1/webhooks/:id/test: a `ping` delivery, recorded and sent now, once (no retries).
 * The route checks the caller's right to the hook, in their own scope, first.
 */
export async function sendTestPing(
  deps: DeliverDeps,
  hook: { id: string; locationId: string },
): Promise<{ httpStatus: number | null }> {
  // `evt_ping` and 24 letters and digits: never mistaken for an audit event's id (fanout.ts).
  const eventId = `evt_ping${randomBytes(18).toString('base64url').replace(/[-_]/g, 'x')}`;
  const deliveryId = await withSystem(deps.pools.system, async (_tx, c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO public.webhook_deliveries (location_id, webhook_id, event_id, event)
       VALUES ($1, $2, $3, 'ping') RETURNING id`,
      [hook.locationId, hook.id, eventId],
    );
    return rows[0]?.id as string;
  });
  const { httpStatus } = await runWebhookDelivery(deps, { deliveryId });
  return { httpStatus };
}

export function webhookJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'webhook-fanout',
      kind: 'system',
      policy: JOB_POLICIES['webhook-fanout'],
      handler: async (data) => {
        await runWebhookFanout({ pools: deps.pools, send: deps.send, log: deps.log }, data);
      },
    }),
    defineJob({
      name: 'webhook-deliver',
      kind: 'system',
      policy: JOB_POLICIES['webhook-deliver'],
      handler: async (data, meta) => {
        const keys = deps.secretKeys;
        if (!keys) throw new Error('webhook-deliver: this worker has no secret keys');
        await runWebhookDelivery(
          {
            pools: deps.pools,
            keyring: () => keys.get().keyring,
            alerts: { pools: deps.pools, mailer: deps.mailer, channels: deps.channels ?? null },
          },
          data,
          meta,
        );
      },
    }),
  ];
}
