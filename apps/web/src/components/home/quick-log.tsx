/**
 * Quick log on Home (screens §6 "Quick log: Log a reading from Home and from the vehicle"; plan
 * T19; Q23): "Log a reading" shows when the caller has a metered thing they can log on (Home's
 * `meteredThings`, T13). It opens a sheet that picks the thing and its meter, the most recently
 * read first, then the Log a reading sheet.
 *
 * The pick comes from the phone's snapshot (each thing carries its meters and their latest
 * reading, Q18), online and offline alike, so it works the same with no connection. Offline,
 * Home's own count isn't there: the button shows when the snapshot has a metered thing in a
 * location the caller can log in.
 */
import type { SnapThing } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useLocations } from '@/api/queries';
import { EmptyState, LoadingRows } from '@/components/page';
import {
  LogReadingSheet,
  type ReadingSheetTarget,
  useCanLogReading,
  useReadingStore,
} from '@/components/readings/log-reading-sheet';
import { useMeterName } from '@/components/things/meters-section';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useMeterUnit } from '@/lib/units';

/** A gauge, as the board's "Log a reading" button draws it. */
export function GaugeIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={
        className ??
        'size-4 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]'
      }
    >
      <path d="M4.5 16a7.5 7.5 0 1 1 15 0" />
      <path d="m12 16 3.5-4.5" />
    </svg>
  );
}

/** The latest reading of a snapshot thing's meters, for "recent first". */
const lastRead = (t: SnapThing) =>
  (t.meters ?? []).reduce(
    (at, m) => (m.latest && m.latest.takenAt > at ? m.latest.takenAt : at),
    '',
  );

/** The metered things the caller can log on, from the phone's snapshot, recent first. */
export function useQuickLogTargets(enabled: boolean) {
  const store = useReadingStore();
  const locations = useLocations();
  const canLog = useCanLogReading();
  const ids = (locations.data ?? [])
    .map((l) => l.id)
    .filter(canLog)
    .sort();
  return useQuery({
    queryKey: ['quick-log', ids],
    enabled: enabled && !!store && ids.length > 0,
    staleTime: 0,
    // The phone's snapshot: readable with no connection.
    networkMode: 'always',
    queryFn: async (): Promise<ReadingSheetTarget[]> => {
      const things = store ? await store.metered(ids) : [];
      return things
        .filter((t) => t.name)
        .sort(
          (a, b) =>
            lastRead(b).localeCompare(lastRead(a)) || (a.name ?? '').localeCompare(b.name ?? ''),
        )
        .flatMap((t) =>
          (t.meters ?? []).map((m) => ({
            thingId: t.id,
            thingName: t.name ?? '',
            locationId: t.locationId,
            meter: {
              id: m.id,
              kind: m.kind,
              unit: m.unit,
              label: m.label,
              latest: m.latest ?? null,
            },
          })),
        );
    },
  });
}

export function QuickLog({ meteredThings }: { meteredThings: number | undefined }) {
  const online = useOnline();
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<ReadingSheetTarget | null>(null);
  // Offline there's no Home count: ask the snapshot whether there is anything to log on.
  const offlineTargets = useQuickLogTargets(!online && meteredThings === undefined);
  const show = online
    ? (meteredThings ?? 0) > 0
    : (meteredThings ?? 0) > 0 || (offlineTargets.data?.length ?? 0) > 0;
  if (!show) return null;
  return (
    <>
      <Button variant="secondary" className="justify-self-start" onPress={() => setPicking(true)}>
        <GaugeIcon />
        <Trans>Log a reading</Trans>
      </Button>
      <PickMeterSheet
        isOpen={picking}
        onClose={() => setPicking(false)}
        onPick={(x) => {
          setPicking(false);
          setTarget(x);
        }}
      />
      <LogReadingSheet target={target} onClose={() => setTarget(null)} />
    </>
  );
}

function PickMeterSheet({
  isOpen,
  onClose,
  onPick,
}: {
  isOpen: boolean;
  onClose: () => void;
  onPick: (target: ReadingSheetTarget) => void;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const meterName = useMeterName();
  const unitOf = useMeterUnit();
  const targets = useQuickLogTargets(isOpen);
  const list = targets.data ?? [];
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`What did you read?`}
    >
      {targets.isPending && targets.fetchStatus !== 'idle' ? (
        <LoadingRows rows={3} label={t`Finding things with a meter`} />
      ) : list.length === 0 ? (
        <EmptyState title={<Trans>Nothing on this phone has a meter yet</Trans>}>
          <Trans>
            Open Kept once while online, so this phone has your things and their meters.
          </Trans>
        </EmptyState>
      ) : (
        <ul className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0">
          {list.map((x) => (
            <li
              key={`${x.thingId}:${x.meter.id}`}
              className="not-first:border-t not-first:border-line"
            >
              <AriaButton
                onPress={() => onPick(x)}
                className="grid min-h-12 w-full cursor-pointer gap-0.5 px-3.5 py-2.5 text-start outline-none data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-hovered:bg-sunken"
              >
                <span className="font-medium text-ink [overflow-wrap:anywhere]">
                  <bdi>{x.thingName}</bdi>
                  {sep()}
                  <bdi>{meterName(x.meter)}</bdi>
                </span>
                <span className="text-small text-ink-2">
                  {x.meter.latest ? (
                    <Trans>
                      Last read{' '}
                      <span className="tabular-nums">
                        {fmt.num(Number(x.meter.latest.value))} {unitOf(x.meter.unit)}
                      </span>
                      , {fmt.day(x.meter.latest.takenAt)}
                    </Trans>
                  ) : (
                    <Trans>No readings yet</Trans>
                  )}
                </span>
              </AriaButton>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
