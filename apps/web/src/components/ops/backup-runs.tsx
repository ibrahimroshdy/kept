/**
 * Admin → Backups' runs (plan T21, frame 106): every backup, pre-upgrade snapshot, drill and
 * repository check, newest first, on the list standard (L88): search (an error or the target),
 * kind and status filters, grouped by day, "Load more" pages, all held in the URL. A run that
 * failed or needs a look explains itself in words (ops-words.ts), never a code.
 */
import {
  BACKUP_RUN_KINDS,
  BACKUP_RUN_STATES,
  type BackupRun,
  type BackupRunKind,
  type BackupRunState,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useBackupRuns } from '@/api/ops/queries';
import type { BackupRunsParams } from '@/api/ops/types';
import { ServerIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Pill, type PillTone } from '@/components/page';
import { useFormat } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { firstOf, useListState } from '@/lib/url-state';
import { useRunWords, useSize } from './ops-words';

const TONES: Record<BackupRunState, PillTone> = {
  running: 'info',
  ok: 'ok',
  warning: 'warn',
  failed: 'danger',
};

const time = (iso: string, tag: string) =>
  new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(iso),
  );

function RunRow({ run }: { run: BackupRun }) {
  const f = useFormat();
  const { locale: lang, digits } = usePrefs();
  const locale = formatLocale(lang, digits);
  const size = useSize();
  const words = useRunWords();
  const why = words.explain(run);
  const span = run.finishedAt
    ? `${time(run.startedAt, locale)}–${time(run.finishedAt, locale)}`
    : time(run.startedAt, locale);
  const added = run.bytesAdded !== null ? size(run.bytesAdded) : null;
  const versions =
    run.kind === 'pre_upgrade' && run.fromVersion && run.toVersion
      ? `${run.fromVersion} → ${run.toVersion}`
      : null;
  return (
    <div className="flex min-h-14 flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-2.5">
      <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
        <div className="font-semibold text-[15px] [overflow-wrap:anywhere]">
          {words.kind(run.kind)}
          {f.sep}
          <span className="tabular-nums">{span}</span>
        </div>
        {why ? <div className="text-small text-ink-2 [text-wrap:pretty]">{why}</div> : null}
        {!why && (added || versions) ? (
          <div className="text-small text-ink-2">
            {versions ? <span className="ltr">{versions}</span> : null}
            {versions && added ? f.sep : null}
            {added ? <Trans>{added} added</Trans> : null}
          </div>
        ) : null}
      </div>
      <Pill tone={TONES[run.status]}>{words.status(run.status)}</Pill>
    </div>
  );
}

export function BackupRuns() {
  const { t } = useLingui();
  const f = useFormat();
  const words = useRunWords();
  const [list] = useListState();
  const kind = firstOf(list, 'kind') as BackupRunKind | undefined;
  const status = firstOf(list, 'status') as BackupRunState | undefined;
  const q = list.q.trim();
  const params: BackupRunsParams = {
    ...(kind && (BACKUP_RUN_KINDS as readonly string[]).includes(kind) ? { kind } : {}),
    ...(status && (BACKUP_RUN_STATES as readonly string[]).includes(status) ? { status } : {}),
    ...(q ? { q } : {}),
  };
  const query = useBackupRuns(params);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const dayOf = (iso: string) => {
    const key = new Date(iso).toDateString();
    const long = f.longDay(iso);
    return {
      key,
      label: key === today ? t`Today · ${long}` : key === yesterday ? t`Yesterday · ${long}` : long,
    };
  };
  return (
    <ListSurface<BackupRun>
      label={t`Backup runs`}
      search={{ label: t`Search runs`, placeholder: t`Search by error or target` }}
      filters={[
        {
          key: 'kind',
          label: t`Kind`,
          kind: 'single',
          values: {
            from: 'static',
            options: BACKUP_RUN_KINDS.map((k) => ({ value: k, label: words.kind(k) })),
          },
        },
        {
          key: 'status',
          label: t`Status`,
          kind: 'single',
          values: {
            from: 'static',
            options: BACKUP_RUN_STATES.map((s) => ({ value: s, label: words.status(s) })),
          },
        },
      ]}
      groups={[
        { value: 'day', label: t`Day`, short: t`by day` },
        { value: 'kind', label: t`Kind`, short: t`by kind` },
        { value: 'none', label: t`None` },
      ]}
      defaultGroup="day"
      groupOf={(r, by) =>
        by === 'day'
          ? dayOf(r.startedAt)
          : by === 'kind'
            ? { key: r.kind, label: words.kind(r.kind) }
            : null
      }
      query={query}
      getKey={(r) => r.id}
      renderRow={(r) => <RunRow run={r} />}
      empty={
        <EmptyState icon={<ServerIcon />} title={<Trans>No backups yet</Trans>}>
          <Trans>Each night's backup, and every Run now, shows here.</Trans>
        </EmptyState>
      }
    />
  );
}
