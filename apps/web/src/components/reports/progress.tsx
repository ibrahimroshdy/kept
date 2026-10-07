/**
 * A report run after "Make the PDF" (D201, task 32): polls the run and shows where it is. Waiting,
 * then a progress bar over `{done, total}` (the things, then the render), then the finished PDF
 * as buttons (lib/files.ts): Open PDF (the inline link in a new tab), Share (the PDF itself, on
 * the share sheet, where the browser shares files) and Download (wherever downloads work). An
 * installed iPhone app can't download, so the download starts by itself only off Apple's phones
 * and tablets. A failure says why, from the run's `error`, with Try again; so does a run past
 * its 24 hours.
 *
 * The links live five minutes. The sheet uses them for at most LINK_USABLE_MS after reading the
 * run, reads it again before that (and on coming back to the page), and while a new one is on
 * its way Open and Download wait for it.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ProgressBar } from 'react-aria-components';
import { LINK_USABLE_MS, useReportRun } from '@/api/inventory/reports';
import type { ReportRun } from '@/api/inventory/types';
import { DocumentIcon, RetryIcon, ShareIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { autoDownloads, canShareType, downloadsWork, downloadUrl, shareFiles } from '@/lib/files';
import { useFormat } from '@/lib/format';

/** The server's cap on one report (apps/server/src/reports/gather.ts `MAX_THINGS`). */
const MAX_THINGS = 2000;
/** How long a run and its PDF are kept (service.ts: 24 hours after the request). */
const KEPT_HOURS = 24;

/** The name the server gives the PDF (service.ts `filenameOf`): the run's UTC day. */
export function reportFilename(run: Pick<ReportRun, 'createdAt'>): string {
  return `kept-inventory-${run.createdAt.slice(0, 10)}.pdf`;
}

/** The name a shared PDF of another kind gets: `kept-<kind>-<day>.pdf` (the insurance report). */
export const reportFilenameOf =
  (kind: string) =>
  (run: Pick<ReportRun, 'createdAt'>): string =>
    `kept-${kind}-${run.createdAt.slice(0, 10)}.pdf`;

/**
 * Whether the links in hand are young enough to use, re-checked when they age out and when the
 * page comes back into view; `recheck` asks again now (a press on an aged link).
 */
function useLinksFresh(readAt: number, active: boolean): { fresh: boolean; recheck: () => void } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const left = readAt + LINK_USABLE_MS - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, left) + 50);
    const onShow = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [readAt, active]);
  return {
    fresh: Math.max(now, readAt) - readAt < LINK_USABLE_MS,
    recheck: () => setNow(Date.now()),
  };
}

/** The finished PDF as a File, fetched once through a fresh link, for the share sheet. Only
 * where the browser can share a PDF; an error (a store the page may not fetch) hides Share. */
function useReportFile(
  run: ReportRun | undefined,
  enabled: boolean,
  filename: (run: ReportRun) => string,
) {
  const url = run?.fileUrl;
  return useQuery({
    queryKey: ['reports', 'file', run?.id ?? ''],
    queryFn: async () => {
      if (!run || !url) throw new Error('no link');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new File([await res.blob()], filename(run), { type: 'application/pdf' });
    },
    enabled: enabled && !!url,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: 1,
  });
}

/** Open PDF, Share and Download for a done run. */
function ReadyActions({
  run,
  fresh,
  recheck,
  file,
}: {
  run: ReportRun;
  fresh: boolean;
  recheck: () => void;
  file: File | undefined;
}) {
  const { t } = useLingui();
  const [sharing, setSharing] = useState(false);
  const viewUrl = run.viewUrl ?? run.fileUrl;
  const canDownload = downloadsWork();
  // A press on a link that aged since the last check waits for the new one instead.
  const guard = (e: MouseEvent) => {
    if (fresh) return;
    e.preventDefault();
    recheck();
  };
  const share = async () => {
    if (!file) return;
    setSharing(true);
    const how = await shareFiles([file]);
    setSharing(false);
    if (how === 'refused') toast({ tone: 'danger', title: t`Couldn't share the PDF. Try again.` });
  };
  const waiting = (label: ReactNode, variant: 'primary' | 'secondary') => (
    <Button variant={variant} size="small" isPending>
      {label}
    </Button>
  );
  const open = <Trans>Open PDF</Trans>;
  const download = <Trans>Download</Trans>;
  return (
    <div className="flex flex-wrap gap-2">
      {viewUrl && fresh ? (
        <a
          href={viewUrl}
          target="_blank"
          rel="noopener"
          onClick={guard}
          className={buttonClass('primary', 'small')}
        >
          <DocumentIcon className="size-4" />
          {open}
        </a>
      ) : (
        waiting(open, 'primary')
      )}
      {file ? (
        <Button variant="secondary" size="small" isPending={sharing} onPress={() => void share()}>
          <ShareIcon className="size-4" />
          <Trans>Share</Trans>
        </Button>
      ) : null}
      {canDownload && run.fileUrl ? (
        fresh ? (
          <a
            href={run.fileUrl}
            rel="noopener"
            onClick={guard}
            className={buttonClass('secondary', 'small')}
          >
            {download}
          </a>
        ) : (
          waiting(download, 'secondary')
        )
      ) : null}
    </div>
  );
}

function useFailureText() {
  const { t } = useLingui();
  const f = useFormat();
  return (run: ReportRun): string => {
    const hours = f.num(KEPT_HOURS);
    if (run.status === 'expired')
      return t`It was kept for ${hours} hours and has been removed. Make it again.`;
    switch (run.error) {
      case 'too_many_things': {
        const max = f.num(MAX_THINGS);
        return t`A report holds at most ${max} things. Choose some places, types or tags to make it smaller.`;
      }
      case 'timeout':
      case 'memory':
        return t`It was too big to finish. Choose some places, types or tags to make it smaller.`;
      default:
        return t`Something went wrong on the server. Try again.`;
    }
  };
}

export function ReportProgress({
  runId,
  onRetry,
  filename = reportFilename,
}: {
  runId: string;
  onRetry: () => void;
  /** The shared PDF's name (the inventory report's by default). */
  filename?: (run: ReportRun) => string;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const errorText = useErrorText();
  const failure = useFailureText();
  const query = useReportRun(runId);
  const run = query.data;
  const opened = useRef(false);
  const hours = f.num(KEPT_HOURS);
  const done = run?.status === 'done';
  const links = useLinksFresh(query.dataUpdatedAt, done);
  const fileUrl = done && links.fresh ? run?.fileUrl : undefined;
  const [shareable] = useState(() => canShareType('kept-inventory.pdf', 'application/pdf'));
  const file = useReportFile(done ? run : undefined, shareable && links.fresh, filename);
  // Aged links: read the run again for new ones (the poll does too, a minute before this).
  const { refetch, isFetching } = query;
  useEffect(() => {
    if (done && !links.fresh && !isFetching) void refetch();
  }, [done, links.fresh, isFetching, refetch]);
  // Once, by itself, where a download can start without a press.
  useEffect(() => {
    if (!fileUrl || opened.current) return;
    opened.current = true;
    if (autoDownloads()) downloadUrl(fileUrl);
  }, [fileUrl]);

  const retry = (
    <Button variant="secondary" size="small" onPress={onRetry}>
      <RetryIcon className="size-4" />
      <Trans>Try again</Trans>
    </Button>
  );

  if (query.error)
    return (
      <Notice tone="danger" title={<Trans>Couldn't check on the PDF</Trans>} action={retry}>
        {errorText(query.error)}
      </Notice>
    );
  if (!run || run.status === 'queued')
    return (
      <ProgressBar aria-label={t`Making the PDF`} isIndeterminate className="grid gap-1.5">
        <span className="text-small text-ink-2">
          <Trans>Waiting to start…</Trans>
        </span>
        <span className="h-1.5 overflow-hidden rounded-full bg-sunken">
          <span className="block h-full w-1/3 animate-pulse bg-amber" />
        </span>
      </ProgressBar>
    );
  if (run.status === 'running') {
    const done = f.num(run.progress.done);
    const total = f.num(run.progress.total);
    return (
      <ProgressBar
        aria-label={t`Making the PDF`}
        value={run.progress.done}
        maxValue={Math.max(1, run.progress.total)}
        valueLabel={t`${done} of ${total}`}
        className="grid gap-1.5"
      >
        {({ percentage, valueText }) => (
          <>
            <span className="flex justify-between gap-3 text-small text-ink-2">
              <Trans>Making the PDF…</Trans>
              <span className="tabular-nums">{valueText}</span>
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-sunken">
              <span
                className="block h-full bg-amber transition-[width]"
                style={{ width: `${percentage ?? 0}%` }}
              />
            </span>
          </>
        )}
      </ProgressBar>
    );
  }
  if (run.status === 'done')
    return (
      <Notice
        tone="ok"
        title={<Trans>Your PDF is ready</Trans>}
        action={
          <ReadyActions run={run} fresh={links.fresh} recheck={links.recheck} file={file.data} />
        }
      >
        <Trans>It's kept for {hours} hours.</Trans>
      </Notice>
    );
  return (
    <Notice
      tone={run.status === 'expired' ? 'warn' : 'danger'}
      title={
        run.status === 'expired' ? (
          <Trans>This PDF has expired</Trans>
        ) : (
          <Trans>Couldn't make the PDF</Trans>
        )
      }
      action={retry}
    >
      {failure(run)}
    </Notice>
  );
}
