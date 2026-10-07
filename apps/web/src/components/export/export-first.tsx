/**
 * "Export first" (D149; plan T21): before a location is deleted, its owner can take a copy of
 * everything in it, its files and a readable copy. It starts an export and follows it here;
 * once ready, Download (a fresh link per click). Optional: deleting doesn't wait for it.
 */
import { newId } from '@kept/shared';
import { Trans } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ProgressBar } from 'react-aria-components';
import { portabilityApi, portabilityKeys, useExportRun } from '@/api/portability/queries';
import { Notice } from '@/components/page';
import { useFileSize } from '@/components/portability/size';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { downloadExport, useExportErrorText, useExportFailure } from './labels';

export function ExportFirst({ locationId, name }: { locationId: string; name: string }) {
  const f = useFormat();
  const qc = useQueryClient();
  const online = useOnline();
  const size = useFileSize();
  const errorText = useExportErrorText();
  const failure = useExportFailure();
  const [runId, setRunId] = useState<string | null>(null);
  const run = useExportRun(runId);
  const start = useMutation({
    mutationFn: () => portabilityApi.createExport({ id: newId(), scope: { locationId } }),
    onSuccess: (r) => {
      setRunId(r.id);
      void qc.invalidateQueries({ queryKey: portabilityKeys.exports.all });
    },
  });
  const download = useMutation({
    mutationFn: () => downloadExport(runId as string),
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const r = run.data;
  return (
    <div className="grid gap-2 rounded-[10px] border border-line p-3.5">
      <h3 className="m-0 font-semibold text-[16px]">
        <Trans>Export first</Trans>
      </h3>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          A copy of everything in <bdi>{name}</bdi>, its files and a readable copy, before it goes.
        </Trans>
      </p>
      {start.isError ? <Notice tone="danger">{errorText(start.error)}</Notice> : null}
      {!runId ? (
        <Button
          variant="secondary"
          className="justify-self-start"
          isDisabled={!online}
          isPending={start.isPending}
          onPress={() => start.mutate()}
        >
          <Trans>Export first</Trans>
        </Button>
      ) : !r || r.status === 'queued' || r.status === 'running' ? (
        <ProgressBar
          aria-label={`${name}`}
          value={r?.progress.done ?? 0}
          maxValue={Math.max(r?.progress.total ?? 0, 1)}
          className="grid gap-1.5"
        >
          {({ percentage }) => (
            <>
              <span className="text-small text-ink-2">
                <Trans>Exporting…</Trans>
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
      ) : r.status === 'done' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-small text-ink-2">
            <Trans>Exported</Trans>
            {r.bytes !== undefined ? `${f.sep}${size(r.bytes)}` : null}
          </span>
          <Button size="small" isPending={download.isPending} onPress={() => download.mutate()}>
            <Trans>Download</Trans>
          </Button>
        </div>
      ) : (
        <Notice tone="danger" title={<Trans>The export didn't finish</Trans>}>
          {failure(r.error)}
        </Notice>
      )}
    </div>
  );
}
