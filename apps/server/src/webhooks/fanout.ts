import type { WebhookEvent } from '@kept/shared';
import type pg from 'pg';
import type { Pools } from '../db/pools.js';
import { type Tx, withSystem } from '../db/scope.js';

// Where webhook events come from (step-6 plan Q18, T15; engineering spec §2.6; D63, D110, D172).
//
// audited() already sees every write. For an event whose action maps to a webhook event, it asks
// whether the location has an active hook taking that event (kept.webhooks_listening(), a yes or
// no: a member can't read the hooks) and, only then, sends `webhook-fanout {auditEventId}` on
// the write's own transaction. So a rolled-back write never fans out, and a location with no
// hooks costs one cheap query per mapped event, nothing more.
//
// The fan-out job runs as kept_system. Its data only names the audit event; what it sends is
// read from that event (the rule in jobs/boss.ts): its location, its action and its diff's field
// names. It writes one `webhook_deliveries` row per active hook taking the event (unique per hook
// and event, so a retried fan-out adds nothing) and sends a `webhook-deliver` job for each, in
// the same transaction (deliver.ts).
//
// The event id is the audit event's own id (`evt_` and its 32 hex digits), so a delivery can
// always find the event it describes, and a receiver can deduplicate on it.
//
// `reminder.due` is the one event no write makes: the reminder scan (reminders/scan.ts) writes
// each occurrence once, as kept_system, and sends `webhook-fanout {occurrenceId}` in the same
// transaction when a hook of the occurrence's location takes `reminder.due`
// (queueReminderWebhook). Its event id is `evt_rem` and the occurrence's 32 hex digits, so it is
// never mistaken for an audit event's, and the payload names the occurrence (entity type
// `reminder`) with no field, kind or date in it.

/** Audit actions that are webhook events. A change that is none of these (a thing marked seen,
 * a label printed) sends nothing. */
export const WEBHOOK_EVENT_OF: Readonly<Record<string, WebhookEvent>> = Object.freeze({
  'thing.create': 'thing.created',
  'thing.duplicate': 'thing.created',
  'thing.update': 'thing.updated',
  'thing.retype': 'thing.updated',
  'thing.codes': 'thing.updated',
  'thing.move': 'thing.moved',
  'thing.trash': 'thing.trashed',
  'thing.restore': 'thing.restored',
  'thing.lifecycle': 'thing.lifecycle_changed',
  'reading.create': 'reading.logged',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `evt_` and the audit event's id without its dashes. */
export function eventIdOf(auditEventId: string): string {
  return `evt_${auditEventId.replaceAll('-', '').toLowerCase()}`;
}

/** The audit event an event id names, or null for one that names none (a ping's). */
export function auditEventIdOf(eventId: string): string | null {
  const m = /^evt_([0-9a-f]{32})$/.exec(eventId);
  if (!m?.[1]) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `evt_rem` and a reminder occurrence's id without its dashes. */
export function reminderEventIdOf(occurrenceId: string): string {
  return `evt_rem${occurrenceId.replaceAll('-', '').toLowerCase()}`;
}

/** The reminder occurrence an event id names, or null for one that names none. */
export function occurrenceIdOf(eventId: string): string | null {
  const m = /^evt_rem([0-9a-f]{32})$/.exec(eventId);
  if (!m?.[1]) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// The audited() side: send the fan-out on the write's transaction
// ---------------------------------------------------------------------------------------------

/** How a fan-out job is sent on a transaction's own connection (jobs/queue.ts JobQueue.send). */
export type FanoutSend = (
  client: pg.ClientBase,
  name: 'webhook-fanout',
  data: { auditEventId: string },
) => Promise<void>;

let fanoutSend: FanoutSend | null = null;

/**
 * Wires audited() to pg-boss. main.ts sets it once its pg-boss has started (web and worker both
 * write audited events); tests set their own. Until then (a CLI, most tests) writes fan out
 * nothing, as they did before step 6.
 */
export function setWebhookFanout(send: FanoutSend | null): void {
  fanoutSend = send;
}

type Mapped = { id: string; locationId: string; event: WebhookEvent };

/** Per transaction: which login it runs as, and what each (location, event) answered. */
const SEEN = new WeakMap<object, { role: string; listening: Map<string, boolean> }>();

function clientOf(tx: Tx): pg.ClientBase | null {
  // drizzle() keeps its client as `$client` (drizzle-orm node-postgres driver).
  return (tx as unknown as { $client?: pg.ClientBase }).$client ?? null;
}

/**
 * Called by audited() and auditedMany() after they write: sends `webhook-fanout` for each event
 * a hook is listening for. A no-op until setWebhookFanout() has run.
 */
export async function queueWebhookFanout(
  tx: Tx,
  events: readonly { id: string; locationId: string | null; action: string }[],
): Promise<void> {
  const send = fanoutSend;
  if (!send) return;
  const mapped: Mapped[] = [];
  for (const e of events) {
    const event = WEBHOOK_EVENT_OF[e.action];
    if (event && e.locationId) mapped.push({ id: e.id, locationId: e.locationId, event });
  }
  if (mapped.length === 0) return;
  const client = clientOf(tx);
  if (!client) return;

  let seen = SEEN.get(tx);
  if (!seen) {
    const { rows } = await client.query<{ role: string }>('SELECT current_user::text AS role');
    seen = { role: rows[0]?.role ?? '', listening: new Map() };
    SEEN.set(tx, seen);
  }
  const key = (m: Mapped) => `${m.locationId}|${m.event}`;
  const unknown = [...new Map(mapped.map((m) => [key(m), m])).values()].filter(
    (m) => !seen.listening.has(key(m)),
  );
  if (unknown.length > 0) {
    // kept_app asks through the door (it can't read the hooks); kept_system (a job's write) and
    // the owner read the hooks' columns directly.
    const sql =
      seen.role === 'kept_app'
        ? `SELECT u.l::text AS location_id, u.e AS event, kept.webhooks_listening(u.l, u.e) AS on
             FROM unnest($1::uuid[], $2::text[]) AS u(l, e)`
        : `SELECT u.l::text AS location_id, u.e AS event,
                  EXISTS (SELECT 1 FROM public.webhooks w
                           WHERE w.location_id = u.l AND w.active AND u.e = ANY (w.events)) AS on
             FROM unnest($1::uuid[], $2::text[]) AS u(l, e)`;
    const { rows } = await client.query<{ location_id: string; event: string; on: boolean }>(sql, [
      unknown.map((m) => m.locationId),
      unknown.map((m) => m.event),
    ]);
    for (const r of rows) seen.listening.set(`${r.location_id}|${r.event}`, r.on === true);
  }
  for (const m of mapped) {
    if (seen.listening.get(key(m))) await send(client, 'webhook-fanout', { auditEventId: m.id });
  }
}

// ---------------------------------------------------------------------------------------------
// The reminder scan's side: `reminder.due`
// ---------------------------------------------------------------------------------------------

/** How the scan sends a system job on its own transaction (ScanDeps.send). */
export type SystemSend = (client: pg.ClientBase, name: string, data: object) => Promise<void>;

/**
 * Called by the reminder scan in the transaction that writes a new occurrence (kept_system):
 * sends `webhook-fanout {occurrenceId}` when an active hook of its location takes
 * `reminder.due`. Returns whether it sent one.
 */
export async function queueReminderWebhook(
  client: pg.ClientBase,
  send: SystemSend,
  occurrence: { id: string; location_id: string },
): Promise<boolean> {
  const { rows } = await client.query<{ on: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.webhooks w
                     WHERE w.location_id = $1 AND w.active AND 'reminder.due' = ANY (w.events)) AS on`,
    [occurrence.location_id],
  );
  if (rows[0]?.on !== true) return false;
  await send(client, 'webhook-fanout', { occurrenceId: occurrence.id });
  return true;
}

// ---------------------------------------------------------------------------------------------
// The job: one delivery per hook
// ---------------------------------------------------------------------------------------------

export type FanoutDeps = {
  pools: Pick<Pools, 'system'>;
  /** Sends `webhook-deliver` on the fan-out's own transaction (SystemJobDeps.send). Omitted:
   * the deliveries are recorded and nothing sends them (the log says so). */
  send?:
    | ((
        client: pg.ClientBase,
        name: string,
        data: object,
        options?: { startAfter?: Date },
      ) => Promise<void>)
    | undefined;
  log?: { error: (obj: object, msg: string) => void } | undefined;
};

/** What a fan-out job names: the location, the event and its id, or null for nothing to send. */
async function sourceOf(
  client: pg.ClientBase,
  raw: unknown,
): Promise<{ locationId: string; event: WebhookEvent; eventId: string } | null> {
  const data = raw as { auditEventId?: unknown; occurrenceId?: unknown } | null;
  const occurrenceId = data?.occurrenceId;
  if (typeof occurrenceId === 'string') {
    if (!UUID.test(occurrenceId)) return null;
    const { rows } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.reminder_occurrences WHERE id = $1',
      [occurrenceId],
    );
    const o = rows[0];
    return o
      ? {
          locationId: o.location_id,
          event: 'reminder.due',
          eventId: reminderEventIdOf(occurrenceId),
        }
      : null;
  }
  const auditEventId = data?.auditEventId;
  if (typeof auditEventId !== 'string' || !UUID.test(auditEventId)) return null;
  const { rows: found } = await client.query<{
    location_id: string | null;
    action: string;
    empty: boolean;
  }>(
    `SELECT location_id, action, diff = '{}'::jsonb AS empty
       FROM public.audit_events WHERE id = $1`,
    [auditEventId],
  );
  const ev = found[0];
  const event = ev ? WEBHOOK_EVENT_OF[ev.action] : undefined;
  if (!ev?.location_id || !event) return null;
  // An update that changed nothing a person sees (only bookkeeping) is no event.
  if (ev.empty && event === 'thing.updated') return null;
  return { locationId: ev.location_id, event, eventId: eventIdOf(auditEventId) };
}

/** Runs one `webhook-fanout` job ({auditEventId} from audited(), {occurrenceId} from the
 * reminder scan). Returns the deliveries it recorded. */
export async function runWebhookFanout(deps: FanoutDeps, raw: unknown): Promise<string[]> {
  const data = raw as { auditEventId?: unknown; occurrenceId?: unknown } | null;
  if (typeof data?.auditEventId !== 'string' && typeof data?.occurrenceId !== 'string') return [];
  return withSystem(deps.pools.system, async (_tx, client) => {
    const src = await sourceOf(client, raw);
    if (!src) return [];
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.webhook_deliveries (location_id, webhook_id, event_id, event, next_attempt_at)
       SELECT w.location_id, w.id, $3, $2, now()
         FROM public.webhooks w
        WHERE w.location_id = $1 AND w.active AND $2 = ANY (w.events)
          -- D180 between the expiry and expire-memberships (security review S5): a hook sends
          -- only while its creator still owns or administers the location.
          AND EXISTS (SELECT 1 FROM public.memberships m
                       WHERE m.user_id = w.created_by AND m.location_id = w.location_id
                         AND m.role IN ('owner', 'admin')
                         AND (m.expires_at IS NULL OR m.expires_at > now()))
       ON CONFLICT (webhook_id, event_id) DO NOTHING
       RETURNING id`,
      [src.locationId, src.event, src.eventId],
    );
    const ids = rows.map((r) => r.id);
    if (!deps.send) {
      if (ids.length > 0)
        deps.log?.error({ deliveries: ids.length }, 'webhook deliveries not sent: no sender');
      return ids;
    }
    for (const deliveryId of ids) await deps.send(client, 'webhook-deliver', { deliveryId });
    return ids;
  });
}
