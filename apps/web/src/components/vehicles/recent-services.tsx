/**
 * A vehicle's latest service records (plan T18): the Overview's "Recent services" card (the
 * Services tab is T20's, ./services-tab.tsx). Each line: what was
 * done, the day, the odometer and the vendor, the schedules it completed and the total (money
 * through the gate, D13).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useVehicleServiceRecords } from '@/api/vehicles/queries';
import type { ServiceRecordV5 } from '@/api/vehicles/types';
import { WrenchIcon } from '@/components/icons';
import { GatedAmount } from '@/components/money/gated';
import { EmptyState, ErrorState, IconTile, List, LoadingRows, Pill } from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { useFormat } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { useMeterUnit } from '@/lib/units';

/** "Front brake pads, tyre rotation": the lines as a list in the reader's language. */
export function useLinesText() {
  const { locale } = usePrefs();
  return (r: Pick<ServiceRecordV5, 'lines'>) => {
    const parts = r.lines.map((l) => l.description).filter(Boolean);
    try {
      return new Intl.ListFormat(locale, { style: 'short', type: 'unit' }).format(parts);
    } catch {
      return parts.join(', ');
    }
  };
}

export function ServiceLine({ record }: { record: ServiceRecordV5 }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  const lines = useLinesText();
  const what = lines(record) || t`Service`;
  const meta = [
    fmt.day(record.servicedOn),
    record.reading
      ? `${fmt.num(Number(record.reading.value))} ${unitOf(record.reading.unit)}`
      : null,
    record.vendor?.name ?? null,
  ].filter((x): x is string => !!x);
  return (
    <div className="flex min-h-14 items-start gap-3 px-3.5 py-2.5" data-service={record.id}>
      <IconTile>
        <WrenchIcon />
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
            <bdi>{what}</bdi>
          </span>
          {record.reviewState === 'draft' ? (
            <Pill tone="warn">
              <Trans>Draft</Trans>
            </Pill>
          ) : null}
        </div>
        <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
          {meta.map((m, i) => (
            <span key={m}>
              {i > 0 ? fmt.sep : null}
              <bdi>{m}</bdi>
            </span>
          ))}
        </div>
        {record.completes.length ? (
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
            <Trans>Completed: {record.completes.map((c) => c.name).join(fmt.sep)}</Trans>
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-small font-medium text-ink tabular-nums">
        <GatedAmount value={record.total} />
      </span>
    </div>
  );
}

/** The latest `limit` records, or all of them with Load more. */
export function ServiceRecordsList({ limit }: { limit?: number }) {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const q = useVehicleServiceRecords(thing.id, limit ? { limit } : {});
  if (q.isPending) return <LoadingRows rows={2} label={t`Loading the services`} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items).slice(0, limit ?? Number.POSITIVE_INFINITY);
  if (items.length === 0)
    return (
      <EmptyState icon={<WrenchIcon />} title={<Trans>No services yet</Trans>}>
        <Trans>Log a service with its invoice, and it shows here with what it cost.</Trans>
      </EmptyState>
    );
  return (
    <List aria-label={t`Services`}>
      {items.map((r) => (
        <li key={r.id}>
          <ServiceLine record={r} />
        </li>
      ))}
    </List>
  );
}
