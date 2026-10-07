/**
 * Your exports (plan T21; §3.3, D180; engineering spec §5 "Export ready / expired"): newest first,
 * as a list-standard list (search by location, State and Location filters, pages, in the URL).
 * A running export shows how far it got and Cancel; a ready one its size, until when, and
 * Download, which asks for a fresh 5-minute link each time (the role checked again); past its
 * seven days "Expired" with Export again; a failed one why, with Try again.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  portabilityApi,
  portabilityKeys,
  useExportRun,
  useExports,
} from '@/api/portability/queries';
import type { ExportRun } from '@/api/portability/types';
import type { LocationSummary } from '@/api/types';
import type { FilterDef } from '@/components/filters/types';
import { useMemoryPages } from '@/components/import/memory-list';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Pill } from '@/components/page';
import { useFileSize } from '@/components/portability/size';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { isNot, useListState } from '@/lib/url-state';
import {
  downloadExport,
  EXPORT_STATES,
  type ExportState,
  STATE_TONE,
  stateOf,
  useExportErrorText,
  useExportFailure,
  useExportStateLabel,
} from './labels';

export function ExportList({
  locations,
  personalId,
  onAgain,
}: {
  /** Every location the caller can see, to name each export's. */
  locations: LocationSummary[];
  personalId: string | undefined;
  /** Export again: the sheet, with this export's scope and options. */
  onAgain: (run: ExportRun) => void;
}) {
  const { t } = useLingui();
  const [list] = useListState();
  const locationName = useLocationName();
  const stateLabel = useExportStateLabel();
  const exports = useExports();
  const all = exports.data?.pages.flatMap((p) => p.items) ?? [];
  const nameOf = (run: ExportRun) => {
    if (run.scope === 'me') return t`My data`;
    const l = locations.find((x) => x.id === run.locationId);
    return l ? locationName(l) : t`A location you no longer run`;
  };

  // Older pages, if any, come with the first: a person has a handful of exports at most (five
  // an hour, kept seven days), so the filters run over all of them.
  useEffect(() => {
    if (exports.hasNextPage && !exports.isFetchingNextPage) void exports.fetchNextPage();
  }, [exports.hasNextPage, exports.isFetchingNextPage, exports.fetchNextPage]);

  const wanted = list.filters.state ?? [];
  const notState = isNot(list, 'state');
  const places = list.filters.location ?? [];
  const notPlace = isNot(list, 'location');
  const q = list.q.trim().toLocaleLowerCase();
  const scopeKey = (r: ExportRun) => (r.scope === 'me' ? 'me' : (r.locationId ?? ''));
  const shown = all.filter((r) => {
    if (wanted.length && wanted.includes(stateOf(r)) === notState) return false;
    if (places.length && places.includes(scopeKey(r)) === notPlace) return false;
    return !q || nameOf(r).toLocaleLowerCase().includes(q);
  });
  const query = useMemoryPages(
    ['exports', exports.dataUpdatedAt, q, wanted, notState, places, notPlace],
    shown,
    25,
  );

  const count = (pred: (r: ExportRun) => boolean) => all.filter(pred).length;
  const scopes = [...new Set(all.map(scopeKey))];
  const filters: FilterDef[] = [
    {
      key: 'state',
      label: t`State`,
      kind: 'multi',
      hideZero: true,
      values: {
        from: 'static',
        options: EXPORT_STATES.map((s: ExportState) => ({
          value: s,
          label: stateLabel(s),
          count: count((r) => stateOf(r) === s),
        })),
      },
    },
    {
      key: 'location',
      label: t`Location`,
      kind: 'multi',
      hideZero: true,
      values: {
        from: 'static',
        options: scopes.map((k) => ({
          value: k,
          label:
            k === 'me' || k === personalId
              ? t`My data`
              : nameOf({ scope: 'location', locationId: k } as ExportRun),
          count: count((r) => scopeKey(r) === k),
        })),
      },
    },
  ];

  return (
    <ListSurface<ExportRun>
      label={t`Exports`}
      search={{ label: t`Search exports`, placeholder: t`Search` }}
      filters={filters}
      query={exports.isPending ? (exports as never) : query}
      getKey={(r) => r.id}
      empty={
        <EmptyState title={<Trans>No exports yet</Trans>}>
          <Trans>Each export is kept here for seven days after it's ready.</Trans>
        </EmptyState>
      }
      renderRow={(r) => <ExportRow run={r} name={nameOf(r)} onAgain={() => onAgain(r)} />}
    />
  );
}

function ExportRow({
  run: listed,
  name,
  onAgain,
}: {
  run: ExportRun;
  name: string;
  onAgain: () => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const online = useOnline();
  const size = useFileSize();
  const stateLabel = useExportStateLabel();
  const failure = useExportFailure();
  const errorText = useExportErrorText();
  const active = listed.status === 'queued' || listed.status === 'running';
  // A running export is followed on its own (polled), and the list refreshed when it ends.
  const live = useExportRun(active ? listed.id : null);
  const run = live.data ?? listed;
  const state = stateOf(run);
  useEffect(() => {
    if (active && live.data && !(live.data.status === 'queued' || live.data.status === 'running'))
      void qc.invalidateQueries({ queryKey: portabilityKeys.exports.list() });
  }, [active, live.data, qc]);

  const download = useMutation({
    mutationFn: () => downloadExport(run.id),
    onSuccess: (fresh) => {
      if (!fresh.fileUrl) {
        toast({ title: t`This export has expired. Export again for a new one.`, tone: 'danger' });
        void qc.invalidateQueries({ queryKey: portabilityKeys.exports.all });
      }
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const cancel = useMutation({
    mutationFn: () => portabilityApi.cancelExport(run.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: portabilityKeys.exports.all }),
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const done = f.num(run.progress.done);
  const total = f.num(run.progress.total);
  const bytes = run.bytes !== undefined ? size(run.bytes) : null;
  const detail =
    state === 'running' ? (
      <Trans>
        Started {f.dateTime(run.createdAt)}
        {f.sep}
        {done} of {total}
      </Trans>
    ) : state === 'queued' ? (
      <Trans>Asked for {f.dateTime(run.createdAt)}</Trans>
    ) : state === 'ready' ? (
      <>
        <Trans>Ready {f.day(run.finishedAt ?? run.createdAt)}</Trans>
        {bytes ? `${f.sep}${bytes}` : null}
        {run.expiresAt ? (
          <>
            {f.sep}
            <Trans>until {f.day(run.expiresAt)}</Trans>
          </>
        ) : null}
      </>
    ) : state === 'expired' ? (
      <>
        <Trans>Made {f.day(run.finishedAt ?? run.createdAt)}</Trans>
        {bytes ? `${f.sep}${bytes}` : null}
      </>
    ) : state === 'failed' ? (
      <>
        {f.day(run.finishedAt ?? run.createdAt)}
        {f.sep}
        {failure(run.error)}
      </>
    ) : (
      f.day(run.finishedAt ?? run.createdAt)
    );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
      <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
        <span className="font-semibold [overflow-wrap:anywhere]">
          <bdi>{name}</bdi>
          {run.includesSecrets ? (
            <span className="font-normal text-ink-2">
              {f.sep}
              <Trans>with secrets</Trans>
            </span>
          ) : null}
        </span>
        <span className="text-small text-ink-2 [overflow-wrap:anywhere]">{detail}</span>
      </div>
      <Pill tone={STATE_TONE[state]}>{stateLabel(state)}</Pill>
      {state === 'ready' ? (
        <Button
          size="small"
          isDisabled={!online}
          isPending={download.isPending}
          onPress={() => download.mutate()}
          aria-label={t`Download the export of ${name}`}
        >
          <Trans>Download</Trans>
        </Button>
      ) : active ? (
        <Button
          size="small"
          variant="secondary"
          isDisabled={!online}
          isPending={cancel.isPending}
          onPress={() => cancel.mutate()}
        >
          <Trans>Cancel</Trans>
        </Button>
      ) : state === 'expired' ? (
        <Button size="small" variant="secondary" isDisabled={!online} onPress={onAgain}>
          <Trans>Export again</Trans>
        </Button>
      ) : state === 'failed' ? (
        <Button size="small" variant="secondary" isDisabled={!online} onPress={onAgain}>
          <Trans>Try again</Trans>
        </Button>
      ) : null}
    </div>
  );
}
