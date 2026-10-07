/**
 * Admin → Backups' snapshots (plan T21, Q4; frame 106): what the repository holds, newest first,
 * read-only. The server reads `restic snapshots` and keeps the answer for 5 minutes (T10), so the
 * list says how fresh it is. Restoring is a command, not a button (`kept admin restore`).
 */
import type { BackupSnapshot } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { isApiError } from '@/api/client';
import { useBackupSnapshots } from '@/api/ops/queries';
import { ErrorState, List, LoadingRows, Notice, Section } from '@/components/page';
import { useFormat } from '@/lib/format';
import { useRunWords, useTestWords } from './ops-words';

function SnapshotRow({ snap }: { snap: BackupSnapshot }) {
  const f = useFormat();
  const words = useRunWords();
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-0.5 px-3.5 py-2">
      <span className="flex-1 basis-40 tabular-nums">{f.dateTime(snap.time)}</span>
      <span className="text-small text-ink-2">
        {snap.kind ? words.kind(snap.kind) : <Trans>Not made by Kept</Trans>}
        {snap.version ? (
          <>
            {f.sep}
            <span className="ltr">v{snap.version.replace(/^v/, '')}</span>
          </>
        ) : null}
      </span>
      <code className="ltr text-[12px] text-ink-3">{snap.id.slice(0, 8)}</code>
    </div>
  );
}

export function SnapshotsList() {
  const { t } = useLingui();
  const f = useFormat();
  const testWords = useTestWords();
  const snaps = useBackupSnapshots();
  const command = 'kept admin restore';
  const cached = snaps.data ? f.relative(snaps.data.cachedAt) : null;
  let body: ReactNode;
  if (snaps.isPending) body = <LoadingRows rows={2} label={t`Loading snapshots`} />;
  else if (snaps.error) {
    const e = snaps.error;
    if (isApiError(e) && e.code === 'backup_not_configured') return null;
    if (isApiError(e) && e.code === 'restic_failed') {
      const reason = e.details.reason as Parameters<typeof testWords>[0];
      const w = testWords(reason);
      body = (
        <Notice tone="warn" title={w.title}>
          {w.body}
        </Notice>
      );
    } else body = <ErrorState error={e} onRetry={() => void snaps.refetch()} />;
  } else if (snaps.data.items.length === 0) {
    body = (
      <p className="m-0 text-ink-2">
        <Trans>No snapshots yet. The first backup makes one.</Trans>
      </p>
    );
  } else {
    body = (
      <List aria-label={t`Snapshots`}>
        {snaps.data.items.map((s) => (
          <li key={s.id}>
            <SnapshotRow snap={s} />
          </li>
        ))}
      </List>
    );
  }
  return (
    <Section
      title={<Trans>Snapshots</Trans>}
      action={
        cached ? (
          <span className="text-small text-ink-3">
            <Trans>From the repository, {cached}</Trans>
          </span>
        ) : null
      }
    >
      {body}
      <p className="m-0 text-small text-ink-3">
        <Trans>
          Restoring is a command, not a button:{' '}
          <code className="ltr whitespace-nowrap">{command}</code> (the backup runbook has the
          steps).
        </Trans>
      </p>
    </Section>
  );
}
