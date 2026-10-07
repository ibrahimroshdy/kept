/** Admin → Alerts (task 25, D166): open ones first, then the recently resolved. */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { useAlerts } from '@/api/queries';
import type { AdminAlert } from '@/api/types';
import { AlertIcon, CheckCircleIcon } from '@/components/icons';
import {
  EmptyState,
  ErrorState,
  IconTile,
  List,
  LoadingRows,
  Pill,
  Section,
} from '@/components/page';
import { sep, useFormat } from '@/lib/format';

export const Route = createFileRoute('/_app/admin/alerts')({ component: AlertsPage });

function useAlertTitle() {
  const { t } = useLingui();
  return (kind: string) => {
    switch (kind) {
      case 'failed_jobs_rising':
        return t`Failed jobs are rising`;
      case 'audit_default_partition':
        return t`History rows landed outside a monthly partition`;
      case 'llm_default_partition':
        return t`AI call records landed outside a monthly partition`;
      case 'backup_failed':
        return t`The nightly backup failed`;
      case 'reminders_not_scanned':
        return t`Reminders have stopped going out`;
      case 'webhook_failing':
        return t`A location's webhook keeps failing`;
      case 'backup_stale':
        return t`No backup for more than 36 hours`;
      case 'disk_space_low':
        return t`A disk is nearly full`;
      case 'bucket_versioning_off':
        return t`Versioning is off on the file bucket`;
      case 'restore_drill_due':
        return t`Time for a restore drill`;
      case 'backup_suspicious_size':
        return t`The latest backup looks too small`;
      default:
        return kind;
    }
  };
}

/** The latest figures from an alert's payload, for the kinds that have a known shape. */
function AlertDetail({ alert }: { alert: AdminAlert }) {
  const f = useFormat();
  const p = alert.payload;
  if (alert.kind === 'failed_jobs_rising' && typeof p.failedLastHour === 'number') {
    const n = f.num(p.failedLastHour);
    return (
      <div className="text-small text-ink-2">
        <Trans>{n} failed in the last hour.</Trans>
      </div>
    );
  }
  if (alert.kind === 'audit_default_partition' && typeof p.rows === 'number') {
    const n = f.num(p.rows);
    return (
      <div className="text-small text-ink-2">
        <Trans>
          {n} rows in audit_events_default. Move them into their month's partition as kept_owner;
          the alert then resolves.
        </Trans>
      </div>
    );
  }
  if (alert.kind === 'llm_default_partition' && typeof p.rows === 'number') {
    const n = f.num(p.rows);
    return (
      <div className="text-small text-ink-2">
        <Trans>
          {n} rows in llm_calls_default. Move them into their month's partition as kept_owner; the
          alert then resolves.
        </Trans>
      </div>
    );
  }
  if (alert.kind === 'backup_failed') {
    const error = typeof p.error === 'string' ? p.error : '';
    const lastOk = typeof p.lastOk === 'string' ? f.dateTime(p.lastOk) : null;
    return (
      <div className="grid gap-1 text-small text-ink-2">
        {error ? <div className="break-words font-mono">{error}</div> : null}
        <div>
          {lastOk ? (
            <Trans>Last good backup {lastOk}. The next good run resolves this alert.</Trans>
          ) : (
            <Trans>No backup has succeeded yet. The next good run resolves this alert.</Trans>
          )}
        </div>
      </div>
    );
  }
  if (alert.kind === 'backup_stale') {
    const lastOk = typeof p.lastOkAt === 'string' ? f.dateTime(p.lastOkAt) : null;
    return (
      <div className="text-small text-ink-2">
        {lastOk ? (
          <Trans>Last good backup {lastOk}. The next good run resolves this alert.</Trans>
        ) : (
          <Trans>No backup has finished yet. The next good run resolves this alert.</Trans>
        )}
      </div>
    );
  }
  if (alert.kind === 'disk_space_low' && typeof p.usedRatio === 'number') {
    const used = f.num(Math.round(p.usedRatio * 100));
    return (
      <div className="text-small text-ink-2">
        {p.volume === 'backup' ? (
          <Trans>The backup disk is {used}% full.</Trans>
        ) : (
          <Trans>The data disk is {used}% full.</Trans>
        )}
      </div>
    );
  }
  if (alert.kind === 'restore_drill_due') {
    const last = typeof p.lastDrillAt === 'string' ? f.dateTime(p.lastDrillAt) : null;
    return (
      <div className="text-small text-ink-2">
        {last ? (
          <Trans>Last restore drill {last}. A new drill resolves this alert.</Trans>
        ) : (
          <Trans>No restore drill yet. A drill resolves this alert.</Trans>
        )}
      </div>
    );
  }
  if (alert.kind === 'reminders_not_scanned') {
    const lastOk = typeof p.lastOkAt === 'string' ? f.dateTime(p.lastOkAt) : null;
    return (
      <div className="grid gap-1 text-small text-ink-2">
        <div>
          {lastOk ? (
            <Trans>
              Kept last checked for due reminders {lastOk}. Until it checks again, nobody gets new
              reminders.
            </Trans>
          ) : (
            <Trans>No check for due reminders has finished yet, so nobody gets reminders.</Trans>
          )}
        </div>
        <div>
          <Trans>
            Failed jobs shows why it stopped; if the worker isn't running, start it again. The next
            good check resolves this alert.
          </Trans>
        </div>
      </div>
    );
  }
  return null;
}

function AlertsPage() {
  const alerts = useAlerts();
  if (alerts.isPending) return <LoadingRows rows={2} />;
  if (alerts.error)
    return <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />;
  const open = alerts.data.filter((a) => !a.resolvedAt);
  const resolved = alerts.data.filter((a) => a.resolvedAt);
  return (
    <div className="grid gap-5">
      {open.length === 0 ? (
        <EmptyState icon={<CheckCircleIcon />} title={<Trans>Nothing needs you</Trans>}>
          <Trans>
            Kept raises an alert here, and emails the instance admins at most once a day, when
            something on the server needs a person.
          </Trans>
        </EmptyState>
      ) : (
        <Section title={<Trans>Open</Trans>}>
          <List>
            {open.map((a) => (
              <li key={a.id}>
                <AlertRow alert={a} />
              </li>
            ))}
          </List>
        </Section>
      )}
      {resolved.length > 0 ? (
        <Section title={<Trans>Resolved</Trans>}>
          <List>
            {resolved.map((a) => (
              <li key={a.id}>
                <AlertRow alert={a} />
              </li>
            ))}
          </List>
        </Section>
      ) : null}
    </div>
  );
}

function AlertRow({ alert }: { alert: AdminAlert }) {
  const f = useFormat();
  const title = useAlertTitle();
  const first = f.dateTime(alert.firstAt);
  const last = f.dateTime(alert.lastAt);
  const resolvedAt = alert.resolvedAt ? f.dateTime(alert.resolvedAt) : null;
  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <IconTile className={resolvedAt ? '' : 'text-warn'}>
        {resolvedAt ? <CheckCircleIcon /> : <AlertIcon />}
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="font-semibold text-[15px]">{title(alert.kind)}</div>
        <div className="text-small text-ink-2">
          <Trans>
            First {first} · last {last}
          </Trans>
          {sep()}
          <Plural value={alert.count} one="raised once" other="raised # times" />
        </div>
        {resolvedAt ? null : <AlertDetail alert={alert} />}
        {resolvedAt ? (
          <Pill tone="ok">
            <Trans>Resolved {resolvedAt}</Trans>
          </Pill>
        ) : null}
      </div>
    </div>
  );
}
