/**
 * Readings logged on this phone that haven't synced yet (Q18): shown on their meter as "52,340
 * km, 2 Oct, waiting to sync", beside the snapshot's latest. Read from the offline queue each
 * time the card shows, and again every few seconds while there are some (the sync engine sends
 * them as soon as it can).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';
import { type PendingReading, pendingReadings } from './enqueue-reading';
import { useReadingStore } from './log-reading-sheet';

export function usePendingReadings(meterId: string) {
  const store = useReadingStore();
  return useQuery({
    queryKey: ['reading-pending', meterId],
    enabled: !!store && !!meterId,
    staleTime: 0,
    // The phone's own queue: readable with no connection.
    networkMode: 'always',
    queryFn: (): Promise<PendingReading[]> =>
      store ? pendingReadings(store, meterId) : Promise.resolve([]),
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 3000 : false),
  });
}

export function PendingReadings({ meterId, unit: stored }: { meterId: string; unit: string }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const unit = useMeterUnit()(stored);
  const pending = usePendingReadings(meterId).data ?? [];
  if (pending.length === 0) return null;
  return (
    <ul aria-label={t`Waiting to sync`} className="m-0 grid list-none gap-1 p-0">
      {pending.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-small text-ink-2">
          <span className="font-semibold text-ink tabular-nums">
            {fmt.num(Number(r.value))} {unit}
          </span>
          <span>{fmt.day(r.takenAt)}</span>
          <span className="text-warn">
            <Trans>waiting to sync</Trans>
          </span>
        </li>
      ))}
    </ul>
  );
}
