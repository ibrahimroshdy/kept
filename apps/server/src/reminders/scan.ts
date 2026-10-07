import { ACTIVE_SOURCE_TYPES, type OccurrenceState } from '@kept/shared';
import type pg from 'pg';
import { resolveAlert } from '../alerts/alerts.js';
import { withSystem } from '../db/scope.js';
import { queueReminderWebhook } from '../webhooks/fanout.js';
import { OCCURRENCE_COLUMNS, type OccurrenceRow } from './items.js';
import { notBefore } from './quiet.js';
import { RecipientBook, type RecipientDeps } from './recipients.js';
import { writeScanStatus } from './status.js';

// `reminder-scan` (every 15 minutes, kept_system; plan T14; §3.4, §7.13; D29, D111, D162):
// 1. Reads the agenda (public.agenda_items, 0053) where a source is reminding now: due, overdue
//    or expiring, the kind its state gives (a loan's `overdue` only once it is: Q7), in pages of
//    2,000.
// 2. Writes each occurrence once: INSERT … ON CONFLICT ON CONSTRAINT reminder_occurrences_key_uq
//    DO NOTHING RETURNING, so only a new one goes on, even with two scans at once (the second
//    waits on the first's key and then does nothing). A snooze or a skip changes the due period,
//    so it makes a new occurrence. One that was closed and is reminding again with the same key
//    (a trashed thing restored, a module turned back on) is opened again, and sends nothing new:
//    its notifications and deliveries were made once, when it was new.
// 3. Closes the open occurrences the agenda no longer reminds of: `done` when the source was
//    completed (a returned loan, a renewed document, a registered warranty, a schedule a
//    confirmed service completed since the occurrence opened: 0056's system_select on
//    service_records and service_completions; a stale reading answered by a newer one, step 5),
//    `superseded` when the source is still
//    on the agenda with another key (a snooze, a skip, due becoming overdue, a new end date),
//    else `cancelled` (the source gone, its module off, its subject trashed or ended; §7.13).
//    Resuming never floods (§7.6): only the current due period ever exists.
// 4. Fans each new occurrence out in the transaction that inserts it: a notification per
//    recipient (the centre), then a delivery per recipient and channel (recipients.ts): `overdue`
//    queued with a `reminder-deliver` job (after the person's quiet hours), `due` and `expiring`
//    waiting for their digest (digest.ts); and a `webhook-fanout` when a location webhook takes
//    `reminder.due` (webhooks/fanout.ts queueReminderWebhook).
// 5. Records the pass in instance_settings.reminder_scan (status.ts) and ends a
//    `reminders_not_scanned` alert.

export type ScanDeps = RecipientDeps & {
  /** Sends a system job on the handler's own transaction (jobs/boss.ts sendInTx). Absent (some
   * tests): deliveries are queued, and nothing sends them. */
  send?:
    | ((
        client: pg.ClientBase,
        name: string,
        data: object,
        options?: { startAfter?: Date },
      ) => Promise<void>)
    | undefined;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

export type ScanOptions = {
  /** The clock for quiet hours (tests). The agenda's "today" is the database's. */
  now?: Date;
  /** Agenda rows read at a time (2,000). */
  pageSize?: number;
};

export type ScanResult = {
  /** Occurrences this pass wrote. */
  occurrences: number;
  /** Closed ones reminding again under the same key. */
  reopened: number;
  closed: Record<Exclude<OccurrenceState, 'open'>, number>;
  notifications: number;
  deliveries: number;
  durationMs: number;
};

export const DELIVER_JOB = 'reminder-deliver';

/** What a reminder-deliver job names: one delivery row (deliver.ts re-reads it). */
export type DeliverJobData = { occurrenceId: string; userId: string; channelId: string };

/** The agenda rows that remind now: due, overdue or expiring, and an `overdue` kind only once
 * the source is overdue (a loan in its lead days is on the Lending screen, not reminded: Q7). */
const REMINDING = `a.state IN ('due', 'overdue', 'expiring') AND (a.kind <> 'overdue' OR a.state = 'overdue')`;

/**
 * A completion `c` by service record `r` counts for occurrence `o` when the record is confirmed (a
 * draft counts nowhere, 0063) and the completion was made since `o` opened: a draft's completions
 * are written by its confirm (step 5, T14), so `c.created_at` (0088) is when it completed, and an
 * unrelated later edit of an older record no longer counts.
 */
export const COMPLETED_SINCE = `r.review_state = 'confirmed' AND c.created_at >= o.created_at`;

/**
 * A stale-reading occurrence `o` was answered: an accepted reading of its meter arrived since it
 * opened, on a later local day than the one it nudged about (the meter's latest accepted reading
 * received before `o` opened; the due day can't say which, as it rolls forward each period, 0089).
 * A reading typed in for that day or an earlier one doesn't answer it.
 */
export const READ_SINCE = `EXISTS (
  SELECT 1 FROM public.meter_readings d
    JOIN public.meters dm ON dm.id = d.meter_id
    JOIN public.locations dl ON dl.id = dm.location_id
   WHERE d.meter_id = o.source_id AND d.state = 'accepted' AND d.received_at >= o.created_at
     AND (d.taken_at AT TIME ZONE dl.timezone)::date > coalesce(
       (SELECT max((pr.taken_at AT TIME ZONE dl.timezone)::date) FROM public.meter_readings pr
         WHERE pr.meter_id = o.source_id AND pr.state = 'accepted'
           AND pr.received_at < o.created_at), '-infinity'::date))`;

/** The §7.13 key of occurrence `o` against agenda row `a` (NULLS NOT DISTINCT, as the index). */
const SAME_KEY = `o.location_id = a.location_id AND o.thing_id IS NOT DISTINCT FROM a.thing_id
      AND o.place_id IS NOT DISTINCT FROM a.place_id AND o.source_type = a.source_type
      AND o.source_id = a.source_id AND o.kind = a.kind AND o.due_period = a.due_period`;

type AgendaRow = Omit<OccurrenceRow, 'id'> & {
  occurrence_id: string | null;
  occurrence_state: OccurrenceState | null;
};

type Cursor = [string, string, string];

async function readPage(
  client: pg.ClientBase,
  after: Cursor | null,
  limit: number,
): Promise<AgendaRow[]> {
  const { rows } = await client.query<AgendaRow>(
    `SELECT a.location_id, a.thing_id, a.place_id, a.source_type, a.source_id, a.kind,
            a.due_period, a.due_on::text AS due_on,
            o.id AS occurrence_id, o.state AS occurrence_state
       FROM public.agenda_items a
       LEFT JOIN public.reminder_occurrences o ON ${SAME_KEY}
      WHERE ${REMINDING}
        -- The sources built so far (stock waits for step 7).
        AND a.source_type = ANY ($5::text[])
        AND ($1::uuid IS NULL OR (a.location_id, a.source_type, a.source_id) > ($1::uuid, $2::text, $3::uuid))
      ORDER BY a.location_id, a.source_type, a.source_id
      LIMIT $4`,
    [after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit, ACTIVE_SOURCE_TYPES],
  );
  return rows;
}

/** A notification per recipient and a delivery per channel, for a new occurrence, in the
 * transaction that inserted it. */
async function fanOut(
  deps: ScanDeps,
  client: pg.ClientBase,
  book: RecipientBook,
  occ: OccurrenceRow,
  now: Date,
): Promise<{ notifications: number; deliveries: number }> {
  let notifications = 0;
  let deliveries = 0;
  const immediate = occ.kind === 'overdue';
  for (const r of await book.of(client, occ)) {
    const n = await client.query(
      `INSERT INTO public.notifications (user_id, location_id, occurrence_id, kind, payload)
       VALUES ($1, $2, $3, 'reminder', $4::jsonb)
       ON CONFLICT ON CONSTRAINT notifications_user_occurrence_uq DO NOTHING`,
      [
        r.userId,
        occ.location_id,
        occ.id,
        JSON.stringify({ sourceType: occ.source_type, sourceId: occ.source_id }),
      ],
    );
    notifications += n.rowCount ?? 0;
    const user = book.user(r.userId);
    const wait =
      immediate && user ? notBefore(now, user.timezone, user.quietFrom, user.quietTo) : null;
    for (const ch of r.channels) {
      const d = await client.query(
        `INSERT INTO public.reminder_deliveries (occurrence_id, user_id, channel_id, status, not_before)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT reminder_deliveries_pk DO NOTHING`,
        [occ.id, r.userId, ch.id, immediate ? 'queued' : 'digest', wait],
      );
      if ((d.rowCount ?? 0) === 0) continue;
      deliveries += 1;
      if (immediate && deps.send) {
        const data: DeliverJobData = { occurrenceId: occ.id, userId: r.userId, channelId: ch.id };
        await deps.send(client, DELIVER_JOB, data, wait ? { startAfter: wait } : {});
      }
    }
  }
  // The location's own webhooks (§2.6, D172): `reminder.due` once per occurrence, whoever its
  // recipients are, through the same fan-out as a write's events (webhooks/fanout.ts).
  if (deps.send) await queueReminderWebhook(client, deps.send, occ);
  return { notifications, deliveries };
}

/** Closes the open occurrences the agenda no longer reminds of, each with why. */
async function closeDropped(client: pg.ClientBase): Promise<ScanResult['closed']> {
  const { rows } = await client.query<{ state: Exclude<OccurrenceState, 'open'> }>(
    `WITH items AS MATERIALIZED (
       SELECT a.location_id, a.thing_id, a.place_id, a.source_type, a.source_id, a.kind,
              a.due_period, a.state, a.due_on, a.due_value
         FROM public.agenda_items a),
     live AS (SELECT * FROM items a WHERE ${REMINDING})
     UPDATE public.reminder_occurrences o
        SET state = CASE
          WHEN o.source_type = 'loan' AND EXISTS (
            SELECT 1 FROM public.loans l WHERE l.id = o.source_id AND l.returned_at IS NOT NULL)
            THEN 'done'
          WHEN o.source_type = 'document' AND EXISTS (
            SELECT 1 FROM public.expiring_documents d
             WHERE d.id = o.source_id AND d.superseded_by_id IS NOT NULL)
            THEN 'done'
          WHEN o.source_type = 'registration' AND EXISTS (
            SELECT 1 FROM public.warranties w WHERE w.id = o.source_id AND w.registered)
            THEN 'done'
          WHEN o.source_type = 'schedule' AND EXISTS (
            SELECT 1 FROM public.service_completions c
              JOIN public.service_records r ON r.id = c.service_record_id
             WHERE c.schedule_id = o.source_id AND ${COMPLETED_SINCE})
            THEN 'done'
          WHEN o.source_type = 'reading_stale' AND ${READ_SINCE}
            THEN 'done'
          WHEN o.source_type = 'stock' AND EXISTS (
            SELECT 1 FROM public.stock_rules r JOIN public.things t ON t.id = r.thing_id
             WHERE r.id = o.source_id AND t.quantity >= r.min_quantity)
            THEN 'done'
          WHEN EXISTS (SELECT 1 FROM items i
                        WHERE i.source_type = o.source_type AND i.source_id = o.source_id)
            THEN 'superseded'
          ELSE 'cancelled' END,
            closed_at = now()
      WHERE o.state = 'open'
        AND NOT EXISTS (SELECT 1 FROM live a WHERE ${SAME_KEY})
      RETURNING o.state`,
  );
  const closed = { done: 0, superseded: 0, cancelled: 0 };
  for (const r of rows) closed[r.state] += 1;
  return closed;
}

/** One pass. Throws when a step fails; the record keeps the last good pass. */
export async function runScan(deps: ScanDeps, opts: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const limit = opts.pageSize ?? 2000;
  await withSystem(deps.pools.system, (_tx, client) =>
    writeScanStatus(client, { lastRunAt: new Date(started).toISOString() }),
  );
  const book = new RecipientBook(deps);
  const result: ScanResult = {
    occurrences: 0,
    reopened: 0,
    closed: { done: 0, superseded: 0, cancelled: 0 },
    notifications: 0,
    deliveries: 0,
    durationMs: 0,
  };
  let after: Cursor | null = null;
  let failed = 0;
  for (;;) {
    const page = await withSystem(deps.pools.system, (_tx, client) =>
      readPage(client, after, limit),
    );
    for (const row of page) {
      if (row.occurrence_id !== null) continue;
      // One transaction per occurrence: it exists with its notifications and deliveries, or not
      // at all (and the next pass writes it). One that fails doesn't stop the others; the pass
      // then fails, so the record and the admin alert say so.
      const made = await withSystem(deps.pools.system, async (_tx, client) => {
        const { rows } = await client.query<OccurrenceRow>(
          `INSERT INTO public.reminder_occurrences AS o
             (location_id, thing_id, place_id, source_type, source_id, kind, due_period, due_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT ON CONSTRAINT reminder_occurrences_key_uq DO NOTHING
           RETURNING ${OCCURRENCE_COLUMNS}`,
          [
            row.location_id,
            row.thing_id,
            row.place_id,
            row.source_type,
            row.source_id,
            row.kind,
            row.due_period,
            row.due_on,
          ],
        );
        const occ = rows[0];
        if (!occ) return null;
        return fanOut(deps, client, book, occ, now);
      }).catch((err: unknown) => {
        failed += 1;
        deps.log?.error(
          { err, sourceType: row.source_type, sourceId: row.source_id },
          'reminder occurrence not written',
        );
        return null;
      });
      if (made) {
        result.occurrences += 1;
        result.notifications += made.notifications;
        result.deliveries += made.deliveries;
      }
    }
    const closedIds = page.filter((r) => r.occurrence_state && r.occurrence_state !== 'open');
    if (closedIds.length > 0) {
      const { rowCount } = await withSystem(deps.pools.system, (_tx, client) =>
        client.query(
          `UPDATE public.reminder_occurrences SET state = 'open', closed_at = NULL
            WHERE id = ANY($1::uuid[]) AND state <> 'open'`,
          [closedIds.map((r) => r.occurrence_id)],
        ),
      );
      result.reopened += rowCount ?? 0;
    }
    const last = page.at(-1);
    if (page.length < limit || !last) break;
    after = [last.location_id, last.source_type, last.source_id];
  }
  result.closed = await withSystem(deps.pools.system, (_tx, client) => closeDropped(client));
  if (failed > 0) throw new Error(`reminder scan: ${failed} occurrences not written`);
  result.durationMs = Date.now() - started;
  await withSystem(deps.pools.system, (_tx, client) =>
    writeScanStatus(client, {
      lastOkAt: new Date().toISOString(),
      occurrences: result.occurrences,
      durationMs: result.durationMs,
    }),
  );
  await resolveAlert(deps.pools, 'reminders_not_scanned');
  return result;
}
