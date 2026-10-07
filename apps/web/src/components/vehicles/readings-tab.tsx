/**
 * A vehicle's Readings tab (plan T18; D26, D27, D52, D195): Log a reading; the odometer proof
 * strip; the readings over time with the usage estimate dashed to the next threshold, and "Show as
 * table"; then the readings list (the `readings` surface: date, source, state). A reading made by
 * a fill or a service says so and opens its owner, where it is changed (Q11).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import type { ReadingSource, ReadingState } from '@/api/inventory/types';
import { useMeterSeries, useReadings } from '@/api/vehicles/queries';
import type { ReadingRow, ReadingsParams } from '@/api/vehicles/types';
import { ChartTable } from '@/components/charts/chart-table';
import { SeriesChart, type SeriesPoint } from '@/components/charts/lazy';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { ActivityIcon, CameraIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Pill, Section } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { useThingCtx } from '@/components/things/context';
import { useReviewReasonLabels } from '@/components/things/labels';
import { useMeterName } from '@/components/things/meters-section';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { useMeterUnit } from '@/lib/units';
import { type ListState, useListState } from '@/lib/url-state';
import { useMainMeter } from './estimates';
import { useVehicleNav } from './nav';
import { ProofStrip } from './proof-strip';
import { LogReadingSheet } from './slots';
import { AdvicePill, ReadingSourceText, UsageText, useReadingSourceLabels } from './words';

const SOURCES: ReadingSource[] = ['manual', 'photo', 'fuel', 'service', 'import', 'home_assistant'];
const STATES: ReadingState[] = ['accepted', 'needs_review'];

/** The URL's list state as `GET /meters/:id/readings` reads it. */
function readingsParams(list: ListState): ReadingsParams {
  const many = (k: string) => list.filters[k] ?? [];
  const not = list.not.filter((k): k is 'when' | 'source' | 'state' =>
    ['when', 'source', 'state'].includes(k),
  );
  const when = many('when')[0];
  return {
    ...(when ? { 'f.when': when } : {}),
    ...(many('source').length ? { 'f.source': many('source') as ReadingSource[] } : {}),
    ...(many('state').length ? { 'f.state': many('state') as ReadingState[] } : {}),
    ...(not.length ? { not } : {}),
    sort: 'takenAt',
    dir: list.dir === 'asc' ? 'asc' : 'desc',
  };
}

export function VehicleReadings() {
  const { thing, location } = useThingCtx();
  const { t } = useLingui();
  const meterName = useMeterName();
  const meter = useMainMeter();
  const unitOf = useMeterUnit();
  const [logging, setLogging] = useState(false);
  const canLog = accessOf(location).can('logs.add');
  if (!meter)
    return (
      <EmptyState icon={<ActivityIcon />} title={<Trans>No meter on this vehicle</Trans>}>
        <Trans>Add an odometer in its Details, and its readings show here.</Trans>
      </EmptyState>
    );
  return (
    <div className="grid min-w-0 gap-5">
      <Section
        title={meterName(meter)}
        action={
          canLog ? (
            <Button size="small" onPress={() => setLogging(true)}>
              <Trans>Log a reading</Trans>
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-2">
          <UsageText estimate={meter.estimate} unit={meter.unit} />
          <AdvicePill estimate={meter.estimate} />
        </div>
      </Section>
      <ProofStrip meterId={meter.id} unit={unitOf(meter.unit)} />
      <ReadingsChart meterId={meter.id} unit={unitOf(meter.unit)} name={meterName(meter)} />
      <ReadingsList meterId={meter.id} unit={unitOf(meter.unit)} />
      {canLog ? (
        <LogReadingSheet
          target={
            logging
              ? {
                  thingId: thing.id,
                  thingName: thing.name ?? t`Untitled`,
                  locationId: thing.locationId,
                  meter,
                }
              : null
          }
          onClose={() => setLogging(false)}
        />
      ) : null}
    </div>
  );
}

/** The readings over time, the estimate dashed to the next threshold, and its table. */
function ReadingsChart({ meterId, unit, name }: { meterId: string; unit: string; name: string }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const { locale, digits } = usePrefs();
  const sources = useReadingSourceLabels();
  const series = useMeterSeries(meterId);
  const meter = useMainMeter();
  if (!series.data || series.data.points.length === 0) return null;
  const s = series.data;
  const unknown = meter?.estimate?.advice === 'unknown';
  const valueText = (v: string) => `${fmt.num(Number(v))} ${unit}`;
  const points: SeriesPoint[] = [
    ...s.points.map((p, i) => ({
      key: `p${i}`,
      at: p.takenAt,
      value: Number(p.value),
      title: fmt.day(p.takenAt),
      valueText: valueText(p.value),
      detail: sources[p.source],
    })),
    // No estimate from a reading too old to trust (D188).
    ...(unknown
      ? []
      : (s.estimate?.through ?? []).map((e, i) => {
          const day = fmt.day(e.at);
          return {
            key: `e${i}`,
            at: e.at,
            value: Number(e.value),
            title: t`estimated ~${day}`,
            valueText: valueText(e.value),
            detail: t`Estimate`,
            estimate: true,
          };
        })),
  ];
  const monthTick = new Intl.DateTimeFormat(formatLocale(locale, digits), {
    month: 'short',
    timeZone: 'UTC',
  });
  const perDay = s.estimate && !unknown ? fmt.num(Math.round(Number(s.estimate.perDay))) : null;
  return (
    <Section
      title={
        <>
          <Trans>
            {name}, {unit}
          </Trans>
          {perDay ? (
            <span className="ms-2 font-normal normal-case text-ink-3">
              <Trans>
                estimate at ~{perDay} {unit} a day
              </Trans>
            </span>
          ) : null}
        </>
      }
    >
      <div className="rounded-[12px] border border-line bg-surface p-3">
        <SeriesChart
          points={points}
          thresholds={s.thresholds.map((th) => ({
            key: th.scheduleId,
            value: Number(th.value),
            label: th.name,
          }))}
          label={t`Readings over time. Arrow keys move between readings.`}
          tick={(n) => fmt.num(n)}
          timeTick={(d) => monthTick.format(d)}
        />
      </div>
      <ChartTable
        caption={t`Readings over time`}
        columns={[
          { key: 'date', label: <Trans>Date</Trans> },
          { key: 'value', label: <Trans>Reading, {unit}</Trans>, numeric: true },
          { key: 'source', label: <Trans>Source</Trans> },
        ]}
        rows={points.map((p) => ({
          key: p.key,
          cells: { date: p.title, value: fmt.num(p.value), source: p.detail ?? '' },
        }))}
      />
    </Section>
  );
}

/** The readings list (the `readings` surface). */
function ReadingsList({ meterId, unit }: { meterId: string; unit: string }) {
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const sources = useReadingSourceLabels();
  const query = useReadings(meterId, readingsParams(list));
  const filters: FilterDef[] = [
    f.date('when', t`Date`),
    {
      key: 'source',
      label: t`Source`,
      icon: <CameraIcon />,
      kind: 'multi',
      values: { from: 'static', options: SOURCES.map((s) => ({ value: s, label: sources[s] })) },
    },
    {
      key: 'state',
      label: t`State`,
      icon: <ActivityIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: STATES.map((s) => ({
          value: s,
          label: s === 'accepted' ? t`Accepted` : t`Needs review`,
        })),
      },
    },
  ];
  return (
    <Section title={<Trans>All readings</Trans>}>
      <ListSurface<ReadingRow>
        label={t`Readings`}
        search={false}
        filters={filters}
        surface="readings"
        sorts={[{ value: 'takenAt', label: t`Date`, kind: 'date' }]}
        query={query}
        getKey={(r) => r.id}
        renderRow={(r) => <ReadingLine reading={r} unit={unit} />}
        empty={
          <p className="m-0 rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-ink-2">
            <Trans>No readings yet.</Trans>
          </p>
        }
      />
    </Section>
  );
}

function ReadingLine({ reading: r, unit }: { reading: ReadingRow; unit: string }) {
  const fmt = useFormat();
  const nav = useVehicleNav();
  const reasons = useReviewReasonLabels();
  return (
    <div className="flex min-h-14 items-start gap-3 px-3.5 py-2.5" data-reading={r.id}>
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-sunken text-ink-3">
        {r.proof?.thumbUrl ? (
          <img src={r.proof.thumbUrl} alt="" className="size-full object-cover" />
        ) : (
          <ActivityIcon className="size-5" />
        )}
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-semibold text-[15px] text-ink tabular-nums">
          {fmt.num(Number(r.value))} {unit}
        </span>
        <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
          {fmt.dateTime(r.takenAt)}
          {fmt.sep}
          <ReadingSourceText source={r.source} by={r.loggedBy} />
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {r.state === 'needs_review' ? (
            <Pill tone="warn">
              {r.reviewReason ? reasons[r.reviewReason] : <Trans>Needs review</Trans>}
            </Pill>
          ) : null}
          {r.ownedBy ? (
            <Button
              size="small"
              variant="ghost"
              onPress={() => nav.go(r.ownedBy?.type === 'fuel' ? 'fuel' : 'services')}
            >
              {r.ownedBy.type === 'fuel' ? (
                <Trans>Part of a fill: change it there</Trans>
              ) : (
                <Trans>Part of a service: change it there</Trans>
              )}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
