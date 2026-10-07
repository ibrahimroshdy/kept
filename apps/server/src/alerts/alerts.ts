import type { Pools } from '../db/pools.js';
import type { AdminAlertKind } from '../db/schema/alerts.js';
import { withSystem } from '../db/scope.js';
import { PGBOSS_SCHEMA } from '../jobs/install.js';
import type { Mailer } from '../mail/mailer.js';
import type { ChannelSenders } from '../reminders/channel.js';
import { readScanStatus, scanOverdue } from '../reminders/status.js';

// Admin alerts (task 25; D166, D185): conditions an instance admin must hear about without
// looking. One row per condition (`dedupe_key`), raised again and again while it lasts (the
// count goes up), resolved when a check finds it gone. Each raise may mail every instance admin,
// at most once per 24 hours per alert, in their own language; the status page and
// GET /api/v1/admin/alerts show them too. Raised and resolved only by kept_system (migration
// 0011). Step 4 adds push (D166: "the admin's own channels"; step-1 carry-over "Admin alerts
// reach email only"): the same 24-hour claim also pushes to each admin's subscribed devices,
// through the web-push sender (reminders/channel.ts, T15's notify/push.ts).

/** Mail an alert's admins at most this often. */
export const ALERT_MAIL_HOURS = 24;

/** failed_jobs_rising: more than this many jobs failed in the last hour (task 25). */
export const FAILED_JOBS_PER_HOUR = 5;

export type AlertDeps = {
  pools: Pick<Pools, 'system'>;
  mailer: Mailer;
  log?: { error: (obj: object, msg: string) => void };
  /** Step 4's channel senders (the worker's SystemJobDeps.channels): the `webpush` one pushes
   * each alert to the instance admins' devices. Absent: mail only. */
  channels?: ChannelSenders | null;
};

export type Raised = {
  id: string;
  count: number;
  /** Whether this raise opened the alert (new, or raised again after it was resolved). */
  opened: boolean;
  /** How many admins were mailed now (0 inside the 24-hour quiet period). */
  mailed: number;
  /** How many admins' devices were pushed to now (step 4). */
  pushed: number;
};

type Recipient = { user_id: string; email: string; locale: string | null };

type PushTo = {
  channelId: string;
  userId: string;
  name: string;
  locale: string;
  timezone: string;
};

/**
 * Raises (or counts again) the alert `dedupeKey`, with its latest figures in `payload`, and
 * mails the instance admins if nobody was mailed about it in the last 24 hours. The mail claim is
 * taken in the same transaction as the raise; if every send fails it is given back, so the next
 * raise tries again.
 */
export async function raiseAlert(
  deps: AlertDeps,
  kind: AdminAlertKind,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<Raised> {
  const raised = await withSystem(deps.pools.system, async (_tx, client) => {
    const { rows } = await client.query<{
      id: string;
      count: number;
      opened: boolean;
    }>(
      `INSERT INTO public.admin_alerts AS a (kind, dedupe_key, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         kind = excluded.kind,
         payload = excluded.payload,
         first_at = CASE WHEN a.resolved_at IS NULL THEN a.first_at ELSE now() END,
         count = CASE WHEN a.resolved_at IS NULL THEN a.count + 1 ELSE 1 END,
         last_at = now(),
         resolved_at = NULL
       RETURNING a.id, a.count, (old.id IS NULL OR old.resolved_at IS NOT NULL) AS opened`,
      [kind, dedupeKey, JSON.stringify(payload)],
    );
    const alert = rows[0];
    if (!alert) throw new Error('admin alert upsert returned nothing');
    const claim = await client.query<{ previous: Date | null }>(
      `UPDATE public.admin_alerts SET mailed_at = now()
        WHERE id = $1
          AND (mailed_at IS NULL OR mailed_at <= now() - make_interval(hours => $2))
        RETURNING old.mailed_at AS previous`,
      [alert.id, ALERT_MAIL_HOURS],
    );
    const recipients = claim.rows[0]
      ? (
          await client.query<Recipient>(
            'SELECT user_id, email, locale FROM kept.instance_admin_recipients()',
          )
        ).rows
      : [];
    // Their web-push channels, when this instance pushes (step 4).
    const pushTo =
      recipients.length > 0 && deps.channels?.webpush
        ? (
            await client.query<PushTo>(
              `SELECT c.id AS "channelId", c.user_id AS "userId", p.display_name AS name,
                      p.locale, p.timezone
                 FROM public.notification_channels c
                 JOIN public.user_profiles p ON p.user_id = c.user_id
                WHERE c.kind = 'webpush' AND c.user_id = ANY($1::uuid[])
                  AND EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = c.user_id)`,
              [recipients.map((r) => r.user_id)],
            )
          ).rows
        : [];
    return { alert, claimed: claim.rows[0] ?? null, recipients, pushTo };
  });

  let mailed = 0;
  for (const r of raised.recipients) {
    try {
      await deps.mailer.send({
        kind: 'admin-alert',
        to: r.email,
        locale: r.locale,
        alert: kind,
        details: payload,
      });
      mailed += 1;
    } catch (err) {
      deps.log?.error({ err, alert: kind }, 'admin alert mail failed');
    }
  }
  let pushed = 0;
  const push = deps.channels?.webpush;
  for (const p of push ? raised.pushTo : []) {
    const outcome = await push
      ?.send(
        { id: p.channelId, kind: 'webpush', userId: p.userId },
        { userId: p.userId, name: p.name, locale: p.locale, timezone: p.timezone, email: null },
        { mode: 'alert', alert: kind, details: payload },
      )
      .catch((err: unknown) => {
        deps.log?.error({ err, alert: kind }, 'admin alert push failed');
        return null;
      });
    if (outcome?.status === 'sent') pushed += 1;
  }
  if (raised.claimed && mailed === 0 && pushed === 0 && raised.recipients.length > 0) {
    // Nobody got it: give the claim back, so the next check mails again.
    await withSystem(deps.pools.system, (_tx, client) =>
      client.query('UPDATE public.admin_alerts SET mailed_at = $2 WHERE id = $1', [
        raised.alert.id,
        raised.claimed?.previous ?? null,
      ]),
    );
  }
  return {
    id: raised.alert.id,
    count: raised.alert.count,
    opened: raised.alert.opened,
    mailed,
    pushed,
  };
}

/** Resolves the alert `dedupeKey` if it is open. Returns whether it was. */
export async function resolveAlert(
  pools: Pick<Pools, 'system'>,
  dedupeKey: string,
): Promise<boolean> {
  return withSystem(pools.system, async (_tx, client) => {
    const { rowCount } = await client.query(
      `UPDATE public.admin_alerts SET resolved_at = now()
        WHERE dedupe_key = $1 AND resolved_at IS NULL`,
      [dedupeKey],
    );
    return (rowCount ?? 0) > 0;
  });
}

export type CheckResult = { raised: AdminAlertKind[]; resolved: AdminAlertKind[] };

/**
 * `check-admin-alerts` (every 15 minutes): each step-1 condition, raised while it holds and
 * resolved once it doesn't.
 * - failed_jobs_rising: more than 5 jobs failed for good in the last hour (D166).
 * - audit_default_partition: audit_events_default holds rows, which blocks that month's
 *   partition and fails the nightly audit-partitions job until an operator moves them (0005).
 * - llm_default_partition: the same for the AI call ledger's llm_calls_default (0040, T6).
 * - reminders_not_scanned: no reminder scan has finished for 2 hours (step 4, T14; §3.4). The
 *   scan resolves it too, after its next good pass.
 */
export async function checkAdminAlerts(
  deps: AlertDeps,
  now: Date = new Date(),
): Promise<CheckResult> {
  const result: CheckResult = { raised: [], resolved: [] };
  const { failed, byQueue, audit, llm, scan } = await withSystem(
    deps.pools.system,
    async (_tx, client) => {
      const jobs = await client.query<{ name: string; n: number }>(
        `SELECT name, count(*)::int AS n FROM ${PGBOSS_SCHEMA}.job
        WHERE state = 'failed' AND completed_on > now() - interval '1 hour'
        GROUP BY name ORDER BY n DESC, name`,
      );
      const def = await client.query<{ n: string; oldest: Date | null; newest: Date | null }>(
        'SELECT n, oldest, newest FROM kept.audit_default_partition_rows()',
      );
      const llmDef = await client.query<{ n: string; oldest: Date | null; newest: Date | null }>(
        'SELECT n, oldest, newest FROM kept.llm_default_partition_rows()',
      );
      return {
        failed: jobs.rows.reduce((sum, r) => sum + r.n, 0),
        byQueue: Object.fromEntries(jobs.rows.map((r) => [r.name, r.n])),
        audit: def.rows[0] ?? { n: '0', oldest: null, newest: null },
        llm: llmDef.rows[0] ?? { n: '0', oldest: null, newest: null },
        scan: await readScanStatus(client),
      };
    },
  );

  const step = async (
    kind: AdminAlertKind,
    holds: boolean,
    payload: () => Record<string, unknown>,
  ) => {
    if (holds) {
      await raiseAlert(deps, kind, kind, payload());
      result.raised.push(kind);
    } else if (await resolveAlert(deps.pools, kind)) {
      result.resolved.push(kind);
    }
  };

  await step('failed_jobs_rising', failed > FAILED_JOBS_PER_HOUR, () => ({
    failedLastHour: failed,
    byQueue,
  }));
  const rows = Number(audit.n);
  await step('audit_default_partition', rows > 0, () => ({
    rows,
    oldest: audit.oldest?.toISOString() ?? null,
    newest: audit.newest?.toISOString() ?? null,
  }));
  const llmRows = Number(llm.n);
  await step('llm_default_partition', llmRows > 0, () => ({
    rows: llmRows,
    oldest: llm.oldest?.toISOString() ?? null,
    newest: llm.newest?.toISOString() ?? null,
  }));
  await step('reminders_not_scanned', scanOverdue(scan, now), () => ({
    lastOkAt: scan?.lastOkAt ?? null,
    lastRunAt: scan?.lastRunAt ?? null,
  }));
  return result;
}
