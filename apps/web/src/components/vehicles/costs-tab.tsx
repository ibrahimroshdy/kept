/**
 * A vehicle's Costs tab (plan T18; the board's desktop frame; D26, D188, Q5, Q22): the last six
 * full months as stacked bars by category (fuel · service and parts · fees and insurance), with a
 * direct label on each month a service was done; the totals, the cost per km over the distance
 * the readings give, the fuel's monthly average; and the current month "so far", outside the bars
 * and never compared with a full month (D188). "Show as table" gives the same numbers.
 *
 * Money is per currency, never converted or added across currencies (Q22): with several, a switch
 * picks the chart's. Without money (a viewer where it's hidden), the distance alone and the notice.
 */
import { type CostCategory, perDistance } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useState } from 'react';
import { useCosts, useFuelSummary } from '@/api/vehicles/queries';
import type { CostAmounts, CostReport } from '@/api/vehicles/types';
import { ChartTable } from '@/components/charts/chart-table';
import { type BarSeries, BarsChart } from '@/components/charts/lazy';
import { ErrorState, LoadingRows, Notice, Section } from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { useMoney } from '@/components/things/values';
import { Segmented } from '@/components/ui/segmented';
import { useFormat } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { useMeterUnit } from '@/lib/units';
import { useConsumption } from './consumption';
import { useMainMeter } from './estimates';

const CATEGORIES: CostCategory[] = ['fuel', 'service', 'fees'];
const COLOUR: Record<CostCategory, string> = {
  fuel: 'var(--s1)',
  service: 'var(--s2)',
  fees: 'var(--s3)',
};

export function useCostCategoryLabels(): Record<CostCategory, string> {
  const { t } = useLingui();
  return { fuel: t`Fuel`, service: t`Service & parts`, fees: t`Fees & insurance` };
}

/** Month names in the reader's language and digits ("Apr", "April 2026", "Apr–Sep 2026"). */
function useMonths() {
  const { locale, digits } = usePrefs();
  const tag = formatLocale(locale, digits);
  const at = (m: string) => new Date(`${m}-01T00:00:00Z`);
  const short = new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shortYear = new Intl.DateTimeFormat(tag, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return {
    tick: (m: string) => short.format(at(m)),
    title: (m: string) => long.format(at(m)),
    cell: (m: string) => shortYear.format(at(m)),
    range: (from: string, to: string) =>
      from === to ? shortYear.format(at(from)) : shortYear.formatRange(at(from), at(to)),
  };
}

export function VehicleCosts() {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const q = useCosts(thing.id);
  if (q.isPending) return <LoadingRows rows={3} label={t`Loading the costs`} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <Costs report={q.data} />;
}

function Costs({ report }: { report: CostReport }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const months = useMonths();
  const labels = useCostCategoryLabels();
  const meter = useMainMeter();
  const unitOf = useMeterUnit();
  const { moduleOn } = useThingCtx();
  const { locale, digits } = usePrefs();
  const compact = new Intl.NumberFormat(formatLocale(locale, digits), {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const currencies = report.totals.map((c) => c.currency);
  const [picked, setPicked] = useState<string>(currencies[0] ?? '');
  const currency = currencies.includes(picked) ? picked : (currencies[0] ?? '');
  const full = report.months.filter((m) => !m.soFar);
  const soFar = report.months.find((m) => m.soFar);
  const period = full.length
    ? months.range(full[0]?.month ?? '', full[full.length - 1]?.month ?? '')
    : '';
  const distance = report.distance
    ? `${fmt.num(Math.round(Number(report.distance.value)))} ${unitOf(report.distance.unit)}`
    : null;

  if (report.moneyHidden)
    return (
      <div className="grid gap-4">
        <Notice title={t`Costs are hidden in this location`}>
          <Trans>An owner or admin decides whether viewers see money here.</Trans>
        </Notice>
        {distance ? (
          <Stat label={t`Distance, ${period}`} value={distance}>
            <Trans>from the readings</Trans>
          </Stat>
        ) : null}
      </div>
    );

  const total = report.totals.find((c) => c.currency === currency);
  const amountOf = (row: (CostAmounts & { currency: string }) | undefined, k: CostCategory) =>
    row ? Number(row[k]) : 0;
  const rowOf = (m: CostReport['months'][number]) =>
    m.byCurrency.find((c) => c.currency === currency);
  const text = (amount: string | undefined) =>
    amount ? money(amount, currency) : money('0', currency);
  const fuelAverage =
    total && full.length
      ? perDistance([{ amount: total.fuel, currency }], String(full.length))[0]?.amount
      : undefined;
  const series: BarSeries[] = CATEGORIES.map((k) => ({
    key: k,
    label: labels[k],
    colour: COLOUR[k],
  }));
  const data = full.map((m) => {
    const row = rowOf(m);
    return {
      key: m.month,
      tick: months.tick(m.month),
      title: months.title(m.month),
      values: Object.fromEntries(CATEGORIES.map((k) => [k, amountOf(row, k)])),
      texts: Object.fromEntries(CATEGORIES.map((k) => [k, text(row?.[k])])),
      totalText: text(row?.total),
      ...(m.notes.length ? { note: m.notes.join(fmt.sep) } : {}),
    };
  });

  return (
    <div className="grid min-w-0 gap-4">
      {currencies.length > 1 ? (
        <Segmented
          label={t`Currency`}
          value={currency}
          onChange={setPicked}
          options={currencies.map((c) => ({ id: c, label: c }))}
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t`Total, ${period}`} value={text(total?.total)}>
          <Plural value={full.length} one="# full month" other="# full months" />
        </Stat>
        {total?.perDistance && distance && meter ? (
          <Stat label={t`Per ${unitOf(report.distance?.unit)}`} value={text(total.perDistance)}>
            <Trans>over {distance} driven</Trans>
          </Stat>
        ) : null}
        {fuelAverage ? (
          <Stat label={t`Fuel, monthly average`} value={text(fuelAverage)}>
            {moduleOn('fuel') ? <FuelLine /> : null}
          </Stat>
        ) : null}
        {soFar ? (
          <Stat label={t`${months.title(soFar.month)} so far`} value={text(rowOf(soFar)?.total)}>
            <Trans>not compared with full months</Trans>
          </Stat>
        ) : null}
      </div>
      <Section
        title={
          <>
            <Trans>Running cost per month, {currency}</Trans>
            <span className="ms-2 font-normal normal-case text-ink-3">{period}</span>
          </>
        }
      >
        <div className="grid gap-2 rounded-[12px] border border-line bg-surface p-3">
          <ul
            aria-hidden="true"
            className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-small"
          >
            {series.map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1.5 text-ink-2">
                <span
                  className="inline-block size-2.5 rounded-sm"
                  style={{ background: s.colour }}
                />
                {s.label}
              </li>
            ))}
          </ul>
          {data.length ? (
            <BarsChart
              data={data}
              series={series}
              label={t`Running cost per month. Arrow keys move between months and categories.`}
              totalLabel={t`Total`}
              tick={(n) => compact.format(n)}
            />
          ) : (
            <p className="m-0 text-small text-ink-2">
              <Trans>No full months yet.</Trans>
            </p>
          )}
        </div>
        <ChartTable
          caption={t`Running cost per month, ${currency}`}
          columns={[
            { key: 'month', label: <Trans>Month</Trans> },
            ...CATEGORIES.map((k) => ({ key: k, label: labels[k], numeric: true })),
            { key: 'total', label: <Trans>Total</Trans>, numeric: true },
          ]}
          rows={full.map((m) => {
            const row = rowOf(m);
            const note = m.notes.length ? `${fmt.sep}${m.notes.join(fmt.sep)}` : '';
            return {
              key: m.month,
              cells: {
                month: `${months.cell(m.month)}${note}`,
                ...Object.fromEntries(CATEGORIES.map((k) => [k, text(row?.[k])])),
                total: text(row?.total),
              },
            };
          })}
        />
      </Section>
    </div>
  );
}

/** The fuel tile's second line: the consumption, when the fuel summary has one (T11). */
function FuelLine() {
  const consumption = useConsumption();
  const { thing } = useThingCtx();
  const summary = useFuelSummary(thing.id);
  const c = summary.data?.byUnit.find((u) => u.consumption)?.consumption;
  const unit = summary.data?.byUnit.find((u) => u.consumption)?.unit;
  if (!c || !unit) return null;
  return <>{consumption(c.perHundred, unit, c.distanceUnit)}</>;
}

function Stat({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5 rounded-[12px] border border-line bg-surface p-3.5">
      <span className="eyebrow">{label}</span>
      <span className="font-semibold text-[22px] text-ink tabular-nums [overflow-wrap:anywhere]">
        <bdi>{value}</bdi>
      </span>
      {children ? <span className="text-small text-ink-2">{children}</span> : null}
    </div>
  );
}
