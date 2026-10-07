/**
 * The import running, and after (plan T30 steps 7–8): progress by rows, with Cancel; a stopped
 * import (failed, or running without moving for IMPORT_STALE_MINUTES) with Resume, which carries
 * on from the row it reached; and the summary, linking to the location and to a search of it.
 * A cancelled import keeps what it already made.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { ProgressBar } from 'react-aria-components';
import type { ImportRun } from '@/api/capture/types';
import { CheckCircleIcon } from '@/components/icons';
import { Notice } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { isStale } from './upload-step';

export function RunProgress({
  run,
  onCancel,
  onResume,
  isBusy,
}: {
  run: ImportRun;
  onCancel: () => void;
  onResume: () => void;
  isBusy: boolean;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const total = run.total ?? 0;
  const done = f.num(run.progress);
  const of = f.num(total);
  const stopped = run.status === 'failed' || isStale(run);
  return (
    <div className="grid gap-4">
      <ProgressBar
        aria-label={t`Imported rows`}
        value={run.progress}
        maxValue={Math.max(total, 1)}
        valueLabel={t`${done} of ${of} rows`}
        className="grid gap-2"
      >
        {({ percentage, valueText }) => (
          <>
            <span className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-[17px]">
                {stopped ? <Trans>The import stopped</Trans> : <Trans>Importing…</Trans>}
              </span>
              <span className="text-small text-ink-2">{valueText}</span>
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-sunken">
              <span
                className="block h-full bg-ink transition-[width]"
                style={{ width: `${percentage ?? 0}%` }}
              />
            </span>
          </>
        )}
      </ProgressBar>
      {stopped ? (
        <Notice
          tone="warn"
          title={<Trans>Resume to carry on from row {done}</Trans>}
          action={
            <Button onPress={onResume} isPending={isBusy}>
              <Trans>Resume</Trans>
            </Button>
          }
        >
          {run.error ? (
            <bdi>{run.error}</bdi>
          ) : (
            <Trans>It hasn't moved for a while. What it already imported stays.</Trans>
          )}
        </Notice>
      ) : (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            You can leave this page; the import carries on, and Settings → Import shows how far it
            got.
          </Trans>
        </p>
      )}
      <Button variant="secondary" className="justify-self-start" onPress={onCancel}>
        <Trans>Cancel the import</Trans>
      </Button>
    </div>
  );
}

export function RunFinished({
  run,
  locationName,
  onAnother,
}: {
  run: ImportRun;
  locationName: string;
  onAnother: () => void;
}) {
  const f = useFormat();
  const rows = f.num(run.progress);
  const cancelled = run.status === 'cancelled';
  return (
    <div className="grid gap-4">
      {cancelled ? (
        <Notice tone="info" title={<Trans>Import cancelled</Trans>}>
          <Trans>
            It stopped after {rows} rows. What it imported before stopping stays in {locationName}.
          </Trans>
        </Notice>
      ) : (
        <div className="grid justify-items-start gap-2 rounded-[10px] border border-line bg-surface p-4">
          <CheckCircleIcon className="size-7 text-ok" />
          <h2 className="m-0 font-semibold text-[20px]">
            <Trans>Imported into {locationName}</Trans>
          </h2>
          <p className="m-0 text-ink-2">
            <Trans>
              All {rows} rows are done. Rows that were skipped in the check were left out; cells
              kept as text are in each thing's notes.
            </Trans>
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Link
          to="/loc/$id"
          params={{ id: run.locationId }}
          className={buttonClass(cancelled ? 'secondary' : 'primary')}
        >
          <Trans>Open {locationName}</Trans>
        </Link>
        <Link
          to="/search"
          search={{ 'f.location': [run.locationId] } as never}
          className={buttonClass('secondary')}
        >
          <Trans>Search {locationName}</Trans>
        </Link>
        <Button variant="ghost" onPress={onAnother}>
          <Trans>Import another file</Trans>
        </Button>
      </div>
    </div>
  );
}
