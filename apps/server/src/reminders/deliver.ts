import type { ChannelKind10 } from '@kept/shared';
import type pg from 'pg';
import { withSystem } from '../db/scope.js';
import { type ChannelMessage, type ChannelTarget, errorCode, type SendOutcome } from './channel.js';
import { OCCURRENCE_COLUMNS, type OccurrenceRow, reminderItems } from './items.js';
import { loadUsers, type RecipientDeps } from './recipients.js';

// `reminder-deliver` (one delivery a job; plan T14; L112): an overdue reminder, sent on one
// channel once the person's quiet hours are over. The job's data only names a delivery row;
// whether to send is read from the database, never trusted from the data (jobs/boss.ts):
// 1. claim the row, `queued` (or `failed`, on a retry) → `sending`, in a transaction that holds it
//    until the send is recorded, so a duplicate job waits and then finds nothing to claim, and a
//    crash mid-send rolls back to `queued` for the retry;
// 2. skip it when the occurrence has closed, the person has left the location, or the channel
//    isn't theirs or is off here;
// 3. send through the channel's sender (reminders/channel.ts, T15) in the person's language, and
//    record `sent`, `skipped` or `failed` with a short code. A failure fails the job, and pg-boss
//    retries it (JOB_POLICIES['reminder-deliver']); a failed send never failed the scan (L112).
//
// A channel's test (T15's routes) may send `{kind: 'test', channelId}` to the same queue: the
// channel's own user gets the test message.

export type DeliverDeps = RecipientDeps & {
  /** KEPT_PUBLIC_URL, for the deep links. */
  publicUrl: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export type DeliverData =
  | { kind: 'delivery'; occurrenceId: string; userId: string; channelId: string }
  | { kind: 'test'; channelId: string };

export function parseDeliverData(data: unknown): DeliverData | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.kind === 'test')
    return isUuid(d.channelId) ? { kind: 'test', channelId: d.channelId } : null;
  if (isUuid(d.occurrenceId) && isUuid(d.userId) && isUuid(d.channelId)) {
    return {
      kind: 'delivery',
      occurrenceId: d.occurrenceId,
      userId: d.userId,
      channelId: d.channelId,
    };
  }
  return null;
}

/** What became of a job: the delivery's end state, or nothing to do. */
export type DeliverResult = SendOutcome['status'] | 'nothing';

async function channelOf(client: pg.ClientBase, channelId: string): Promise<ChannelTarget | null> {
  const { rows } = await client.query<{ id: string; kind: ChannelKind10; user_id: string }>(
    'SELECT id, kind, user_id FROM public.notification_channels WHERE id = $1',
    [channelId],
  );
  const r = rows[0];
  return r ? { id: r.id, kind: r.kind, userId: r.user_id } : null;
}

/** Sends through the channel's sender; a throw is a failure to retry. */
async function sendVia(
  deps: DeliverDeps,
  client: pg.ClientBase,
  target: ChannelTarget,
  message: ChannelMessage,
): Promise<SendOutcome> {
  const sender = deps.channels?.[target.kind];
  if (!sender) return { status: 'skipped', error: 'channel_off' };
  const user = (await loadUsers(deps, client, [target.userId])).get(target.userId);
  if (!user || user.banned) return { status: 'skipped', error: 'no_user' };
  try {
    const out = await sender.send(target, user, message);
    return out.status === 'sent' ? out : { status: out.status, error: errorCode(out.error) };
  } catch {
    return { status: 'failed', error: 'send_error' };
  }
}

async function deliverOne(
  deps: DeliverDeps,
  data: Extract<DeliverData, { kind: 'delivery' }>,
): Promise<SendOutcome | null> {
  return withSystem(deps.pools.system, async (_tx, client) => {
    const claimed = await client.query(
      `UPDATE public.reminder_deliveries SET status = 'sending'
        WHERE occurrence_id = $1 AND user_id = $2 AND channel_id = $3
          AND status IN ('queued', 'failed')
        RETURNING 1`,
      [data.occurrenceId, data.userId, data.channelId],
    );
    if ((claimed.rowCount ?? 0) === 0) return null;
    const outcome = await (async (): Promise<SendOutcome> => {
      const { rows } = await client.query<OccurrenceRow & { state: string; member: boolean }>(
        `SELECT ${OCCURRENCE_COLUMNS}, o.state,
                EXISTS (SELECT 1 FROM public.memberships m
                         WHERE m.location_id = o.location_id AND m.user_id = $2
                           AND (m.expires_at IS NULL OR m.expires_at > now())) AS member
           FROM public.reminder_occurrences o WHERE o.id = $1`,
        [data.occurrenceId, data.userId],
      );
      const occ = rows[0];
      if (occ?.state !== 'open') return { status: 'skipped', error: 'closed' };
      if (!occ.member) return { status: 'skipped', error: 'not_member' };
      const target = await channelOf(client, data.channelId);
      if (!target || target.userId !== data.userId) {
        return { status: 'skipped', error: 'channel_gone' };
      }
      const [item] = await reminderItems(client, [occ], deps.publicUrl);
      if (!item) return { status: 'skipped', error: 'closed' };
      return sendVia(deps, client, target, { mode: 'immediate', item });
    })();
    await client.query(
      `UPDATE public.reminder_deliveries
          SET status = $4, error = $5, sent_at = CASE WHEN $4 = 'sent' THEN now() END
        WHERE occurrence_id = $1 AND user_id = $2 AND channel_id = $3`,
      [
        data.occurrenceId,
        data.userId,
        data.channelId,
        outcome.status,
        outcome.status === 'sent' ? null : outcome.error,
      ],
    );
    return outcome;
  });
}

/** The `reminder-deliver` job. Throws when a send failed, so pg-boss retries it. */
export async function runDelivery(deps: DeliverDeps, raw: unknown): Promise<DeliverResult> {
  const data = parseDeliverData(raw);
  if (!data) return 'nothing';
  const outcome =
    data.kind === 'test'
      ? await withSystem(deps.pools.system, async (_tx, client) => {
          const target = await channelOf(client, data.channelId);
          return target ? sendVia(deps, client, target, { mode: 'test' }) : null;
        })
      : await deliverOne(deps, data);
  if (!outcome) return 'nothing';
  if (outcome.status === 'failed') {
    throw new Error(`reminder delivery failed: ${outcome.error}`);
  }
  return outcome.status;
}
