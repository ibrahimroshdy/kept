import { DEFAULT_DIGEST_TIME } from '@kept/shared';
import type pg from 'pg';
import { withSystem } from '../db/scope.js';
import { type ChannelTarget, errorCode, type ReminderItem } from './channel.js';
import type { DeliverDeps } from './deliver.js';
import { OCCURRENCE_COLUMNS, type OccurrenceRow, reminderItems } from './items.js';
import { loadUsers } from './recipients.js';

// `reminder-digest` (every 15 minutes, kept_system; plan T14; D29, D122; Q9; spike V21): each
// person's daily digest, once their own clock has reached their digest time (08:00 unless they
// chose, in user_profiles.timezone). One message per channel listing every item waiting for it,
// across all their locations, each with its location's own due date.
//
// Exactly once per person, local day and channel: notification_digests' key. The digest row is
// written in the transaction that sends and marks the deliveries `sent`; a failed send rolls it
// all back, and the next pass tries again. The rule is "the first pass at or past the digest
// time on that local date", so a digest time inside the spring-forward gap goes out at the first
// minute after it (01:00 on 24 April 2026 in Cairo), and one inside the autumn overlap goes out
// once. Quiet hours don't delay a digest: the person chose its time.

export type DigestOptions = { now?: Date };

export type DigestResult = { sent: number; skipped: number; failed: number };

type Due = { user_id: string; channel_id: string; digest_on: string };

/** Who is due a digest on which channel, at `now`. */
async function dueDigests(client: pg.ClientBase, now: Date): Promise<Due[]> {
  const { rows } = await client.query<Due>(
    `SELECT d.user_id, d.channel_id, (($1::timestamptz) AT TIME ZONE p.timezone)::date::text AS digest_on
       FROM (SELECT DISTINCT user_id, channel_id FROM public.reminder_deliveries
              WHERE status = 'digest') d
       JOIN public.user_profiles p ON p.user_id = d.user_id
      WHERE (($1::timestamptz) AT TIME ZONE p.timezone)::time
              >= coalesce(p.digest_time, $2::time)
        AND NOT EXISTS (
          SELECT 1 FROM public.notification_digests g
           WHERE g.user_id = d.user_id AND g.channel_id = d.channel_id
             AND g.digest_on = (($1::timestamptz) AT TIME ZONE p.timezone)::date
             AND g.sent_at IS NOT NULL)
      ORDER BY d.user_id, d.channel_id`,
    [now.toISOString(), DEFAULT_DIGEST_TIME],
  );
  return rows;
}

type Waiting = OccurrenceRow & { state: string; member: boolean };

/** One person's digest on one channel. */
async function sendDigest(deps: DeliverDeps, due: Due): Promise<'sent' | 'skipped' | 'nothing'> {
  return withSystem(deps.pools.system, async (_tx, client) => {
    await client.query(
      `INSERT INTO public.notification_digests (user_id, digest_on, channel_id)
       VALUES ($1, $2, $3) ON CONFLICT ON CONSTRAINT notification_digests_pk DO NOTHING`,
      [due.user_id, due.digest_on, due.channel_id],
    );
    const claim = await client.query(
      `SELECT 1 FROM public.notification_digests
        WHERE user_id = $1 AND digest_on = $2 AND channel_id = $3 AND sent_at IS NULL
        FOR UPDATE SKIP LOCKED`,
      [due.user_id, due.digest_on, due.channel_id],
    );
    // Sent already, or another pass is sending it now.
    if ((claim.rowCount ?? 0) === 0) return 'nothing';
    const { rows: waiting } = await client.query<Waiting>(
      `SELECT ${OCCURRENCE_COLUMNS}, o.state,
              EXISTS (SELECT 1 FROM public.memberships m
                       WHERE m.location_id = o.location_id AND m.user_id = d.user_id
                         AND (m.expires_at IS NULL OR m.expires_at > now())) AS member
         FROM public.reminder_deliveries d
         JOIN public.reminder_occurrences o ON o.id = d.occurrence_id
        WHERE d.user_id = $1 AND d.channel_id = $2 AND d.status = 'digest'
        ORDER BY o.due_on NULLS LAST, o.created_at, o.id
        FOR UPDATE OF d`,
      [due.user_id, due.channel_id],
    );
    const mark = (ids: string[], status: string, error: string | null) =>
      ids.length === 0
        ? Promise.resolve()
        : client.query(
            `UPDATE public.reminder_deliveries
                SET status = $4, error = $5, sent_at = CASE WHEN $4 = 'sent' THEN now() END
              WHERE user_id = $1 AND channel_id = $2 AND occurrence_id = ANY($3::uuid[])`,
            [due.user_id, due.channel_id, ids, status, error],
          );
    const closed = waiting.filter((w) => w.state !== 'open').map((w) => w.id);
    const gone = waiting.filter((w) => w.state === 'open' && !w.member).map((w) => w.id);
    await mark(closed, 'skipped', 'closed');
    await mark(gone, 'skipped', 'not_member');
    const live = waiting.filter((w) => w.state === 'open' && w.member);
    if (live.length === 0) return 'nothing';

    const { rows: channels } = await client.query<{
      id: string;
      kind: ChannelTarget['kind'];
      user_id: string;
    }>('SELECT id, kind, user_id FROM public.notification_channels WHERE id = $1', [
      due.channel_id,
    ]);
    const ch = channels[0];
    const ids = live.map((w) => w.id);
    const sender = ch ? deps.channels?.[ch.kind] : undefined;
    const user = (await loadUsers(deps, client, [due.user_id])).get(due.user_id);
    if (!ch || ch.user_id !== due.user_id || !sender || !user || user.banned) {
      await mark(ids, 'skipped', !sender && ch ? 'channel_off' : 'channel_gone');
      return 'skipped';
    }
    const items: ReminderItem[] = await reminderItems(client, live, deps.publicUrl);
    const outcome = await sender
      .send({ id: ch.id, kind: ch.kind, userId: ch.user_id }, user, {
        mode: 'digest',
        digestOn: due.digest_on,
        items,
      })
      .catch(() => ({ status: 'failed' as const, error: 'send_error' }));
    if (outcome.status === 'failed') {
      // Roll back: the digest row and every delivery are as they were, for the next pass.
      throw new DigestFailed(errorCode(outcome.error));
    }
    if (outcome.status === 'skipped') {
      await mark(ids, 'skipped', errorCode(outcome.error));
      return 'skipped';
    }
    await mark(ids, 'sent', null);
    await client.query(
      `UPDATE public.notification_digests SET sent_at = now()
        WHERE user_id = $1 AND digest_on = $2 AND channel_id = $3`,
      [due.user_id, due.digest_on, due.channel_id],
    );
    return 'sent';
  });
}

class DigestFailed extends Error {
  constructor(readonly code: string) {
    super(`digest not sent: ${code}`);
    this.name = 'DigestFailed';
  }
}

/** One pass: every digest due now. Throws after the pass if any failed (the next pass, or
 * pg-boss's retry, tries those again; the sent ones stay sent). */
export async function runDigests(
  deps: DeliverDeps & {
    log?: { error: (obj: object, msg: string) => void };
  },
  opts: DigestOptions = {},
): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const due = await withSystem(deps.pools.system, (_tx, client) => dueDigests(client, now));
  const result: DigestResult = { sent: 0, skipped: 0, failed: 0 };
  for (const d of due) {
    try {
      const done = await sendDigest(deps, d);
      if (done === 'sent') result.sent += 1;
      else if (done === 'skipped') result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      deps.log?.error({ err, userId: d.user_id, channelId: d.channel_id }, 'digest not sent');
    }
  }
  return result;
}
