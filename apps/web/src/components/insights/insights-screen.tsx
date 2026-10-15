/**
 * Insights (1.x, D234; D39 item 8, D54, D113; screens §1): spending on things per year, what
 * things are worth per place and location, what the vehicles cost month by month, and how much is
 * under warranty. Global across your locations with Money on, narrowed by the location chip
 * (D174, `f.location` in the URL).
 *
 * - Money is per currency, never added across currencies or converted (D76): with several, a
 *   switch picks the one each chart draws, and the table under it gives the same numbers.
 * - Where money is hidden from you (a viewer, D13), the section counts instead (purchases, things,
 *   fills and services) and names the locations its amounts leave out.
 * - The current year is "so far" (D188): a figure of its own, never a bar beside full years.
 * - Every bar starts at zero on a linear scale (the vehicle charts' Bars, D133; places as plain
 *   bars on one scale per section). A chart's tooltip, its marks' names and "Show as table" say
 *   the same numbers.
 * - Vehicle costs only where Vehicles is on, warranties only where Warranties & claims is (D113).
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useInsights } from '@/api/insights/queries';
import type { Amount, CostAmounts, Insights } from '@/api/insights/types';
import { useLocations } from '@/api/queries';
import { ChartTable } from '@/components/charts/chart-table';
import { type BarSeries, BarsChart } from '@/components/charts/lazy';
import { useFilterRegistry } from '@/components/filters/registry';
import { FilterStrip } from '@/components/filters/strip';
import { ChartIcon } from '@/components/icons';
import {
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingRows,
  Notice,
  Section,
} from '@/components/page';
import { useModuleAnywhere } from '@/components/schedules/access';
import { useMoney } from '@/components/things/values';
import { Segmented } from '@/components/ui/segmented';
import { addressOf } from '@/lib/address';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useMediaQuery, WIDE } from '@/lib/media';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { useListState } from '@/lib/url-state';

type CostKey = 'fuel' | 'service' | 'fees';
const COST_KEYS: CostKey[] = ['fuel', 'service', 'fees'];
/** The vehicle Costs tab's colours (components/vehicles/costs-tab.tsx), so a category reads the
 * same in both places. */
const COST_COLOUR: Record<CostKey, string> = {
  fuel: 'var(--s1)',
  service: 'var(--s2)',
  fees: 'var(--s3)',
};

const link =
  'rounded text-ink underline-offset-2 outline-none [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-info';

/** Numbers and dates in the reader's language and digits: years without grouping ("2025"), short
 * months ("Apr", "April 2026"), and compact axis ticks ("2k"). */
function useNumbers() {
  const { locale, digits } = usePrefs();
  const tag = formatLocale(locale, digits);
  const year = new Intl.NumberFormat(tag, { useGrouping: false });
  const compact = new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 });
  const at = (m: string) => new Date(`${m}-01T00:00:00Z`);
  const short = new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shortYear = new Intl.DateTimeFormat(tag, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return {
    year: (y: number) => year.format(y),
    years: (from: number, to: number) =>
      from === to ? year.format(from) : `${year.format(from)}–${year.format(to)}`,
    tick: (n: number) => compact.format(n),
    monthTick: (m: string) => short.format(at(m)),
    monthTitle: (m: string) => long.format(at(m)),
    monthCell: (m: string) => shortYear.format(at(m)),
  };
}

/** The currencies a section's amounts are in, in a stable order. */
const currenciesOf = (lists: readonly (readonly { currency: string }[] | undefined)[]) =>
  [...new Set(lists.flatMap((l) => (l ?? []).map((a) => a.currency)))].sort();

const amountIn = (list: readonly Amount[] | undefined, currency: string) =>
  list?.find((a) => a.currency === currency)?.amount;

/** One currency picked from a section's: a switch when there are several. */
function useCurrency(currencies: string[]) {
  const [picked, setPicked] = useState('');
  const currency = currencies.includes(picked) ? picked : (currencies[0] ?? '');
  return { currency, setPicked };
}

function CurrencySwitch({
  currencies,
  value,
  onChange,
}: {
  currencies: string[];
  value: string;
  onChange: (c: string) => void;
}) {
  const { t } = useLingui();
  if (currencies.length < 2) return null;
  return (
    <Segmented
      label={t`Currency`}
      value={value}
      onChange={onChange}
      options={currencies.map((c) => ({ id: c, label: c }))}
    />
  );
}

/** "Amounts leave out Garage: money is hidden from you there." */
function HiddenNotice({ ids }: { ids: string[] }) {
  const { t } = useLingui();
  const locations = useLocations();
  const nameOf = useLocationName();
  const fmt = useFormat();
  if (ids.length === 0) return null;
  const names = ids
    .map((id) => locations.data?.find((l) => l.id === id))
    .map((l) => (l ? nameOf(l) : ''))
    .filter(Boolean)
    .join(fmt.sep);
  return <Notice>{t`Amounts leave out ${names}: money is hidden from you there.`}</Notice>;
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

const card = 'grid min-w-0 gap-3 rounded-[12px] border border-line bg-surface p-3';

// ---------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------

export function InsightsScreen() {
  const { t } = useLingui();
  const money = useModuleAnywhere('money');
  const registry = useFilterRegistry();
  const [list] = useListState();
  const location = list.filters.location ?? [];
  const q = useInsights({ location });

  if (money.loaded && !money.on)
    return (
      <EmptyState icon={<ChartIcon />} title={<Trans>Insights is off in your locations</Trans>}>
        <Trans>
          Insights is part of Money. An owner or admin turns Money on in the location's settings,
          under What to track.
        </Trans>
      </EmptyState>
    );

  return (
    <div className="grid min-w-0 gap-6">
      <FilterStrip filters={[{ ...registry.location(), negatable: false }]} search={false} />
      {q.isPending ? (
        <LoadingRows rows={4} label={t`Loading insights`} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.locations.length === 0 ? (
        <EmptyState icon={<ChartIcon />} title={<Trans>Money is off here</Trans>}>
          <Trans>Insights shows the locations where Money is on. Pick another location.</Trans>
        </EmptyState>
      ) : (
        <>
          <Spending data={q.data} />
          <Value data={q.data} />
          {q.data.vehicles ? <Vehicles data={q.data.vehicles} thisYear={q.data.thisYear} /> : null}
          {q.data.warranties ? (
            <Warranties
              data={q.data.warranties}
              several={q.data.locations.filter((l) => l.warranties).length > 1}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Spending per year
// ---------------------------------------------------------------------------------------------

function Spending({ data }: { data: Insights }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const n = useNumbers();
  const { years, hiddenIn } = data.spending;
  const currencies = currenciesOf(years.map((y) => y.byCurrency));
  const { currency, setPicked } = useCurrency(currencies);
  const full = years.filter((y) => !y.soFar);
  const soFar = years.find((y) => y.soFar);
  const unpriced = years.reduce((a, y) => a + y.unpriced, 0);
  const shown = currencies.length > 0;
  const text = (amount: string | undefined) => money(amount ?? '0', currency);
  const period = full.length ? n.years(full[0]?.year ?? 0, full.at(-1)?.year ?? 0) : '';

  if (years.every((y) => y.purchases === 0))
    return (
      <Section title={<Trans>Spending on things</Trans>}>
        <EmptyState
          title={<Trans>No purchases yet</Trans>}
          action={
            <LinkButton to="/capture">
              <Trans>Capture a receipt</Trans>
            </LinkButton>
          }
        >
          <Trans>Receipts you capture or add to things show up here, by the year you bought.</Trans>
        </EmptyState>
      </Section>
    );

  const total = full.reduce((a, y) => a + Number(amountIn(y.byCurrency, currency) ?? 0), 0);
  const series: BarSeries[] = [
    { key: 'v', label: shown ? t`Spent` : t`Purchases`, colour: 'var(--s1)' },
  ];
  const chartData = full.map((y) => {
    const amount = amountIn(y.byCurrency, currency);
    return {
      key: String(y.year),
      tick: n.year(y.year),
      title: n.year(y.year),
      values: { v: shown ? Number(amount ?? 0) : y.purchases },
      texts: { v: shown ? text(amount) : fmt.num(y.purchases) },
      totalText: shown ? text(amount) : fmt.num(y.purchases),
    };
  });

  return (
    <Section title={<Trans>Spending on things</Trans>}>
      <div className="grid min-w-0 gap-3">
        <CurrencySwitch currencies={currencies} value={currency} onChange={setPicked} />
        <div className="grid gap-3 sm:grid-cols-2">
          {full.length ? (
            <Stat
              label={t`Total, ${period}`}
              value={
                shown
                  ? money(String(total), currency)
                  : fmt.num(full.reduce((a, y) => a + y.purchases, 0))
              }
            >
              {shown ? (
                <Plural
                  value={full.reduce((a, y) => a + y.purchases, 0)}
                  one="# purchase"
                  other="# purchases"
                />
              ) : (
                <Trans>purchases</Trans>
              )}
            </Stat>
          ) : null}
          {soFar ? (
            <Stat
              label={t`${n.year(soFar.year)} so far`}
              value={shown ? text(amountIn(soFar.byCurrency, currency)) : fmt.num(soFar.purchases)}
            >
              <Trans>not compared with full years</Trans>
            </Stat>
          ) : null}
        </div>
        <div className={card}>
          {chartData.length ? (
            <BarsChart
              data={chartData}
              series={series}
              label={
                shown
                  ? t`Spent per year. Arrow keys move between years.`
                  : t`Purchases per year. Arrow keys move between years.`
              }
              totalLabel={t`Total`}
              tick={n.tick}
            />
          ) : (
            <p className="m-0 text-small text-ink-2">
              <Trans>No full years yet.</Trans>
            </p>
          )}
        </div>
        <ChartTable
          caption={shown ? t`Spent per year, ${currency}` : t`Purchases per year`}
          columns={[
            { key: 'year', label: <Trans>Year</Trans> },
            { key: 'purchases', label: <Trans>Purchases</Trans>, numeric: true },
            ...(shown ? [{ key: 'spent', label: <Trans>Spent</Trans>, numeric: true }] : []),
          ]}
          rows={years.map((y) => ({
            key: String(y.year),
            cells: {
              year: y.soFar ? t`${n.year(y.year)} so far` : n.year(y.year),
              purchases: fmt.num(y.purchases),
              spent: text(amountIn(y.byCurrency, currency)),
            },
          }))}
        />
        {unpriced > 0 ? (
          <p className="m-0 text-small text-ink-2">
            <Plural
              value={unpriced}
              one="# purchase has no amount and isn't in the totals."
              other="# purchases have no amount and aren't in the totals."
            />
          </p>
        ) : null}
        <HiddenNotice ids={hiddenIn} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Value per place and location
// ---------------------------------------------------------------------------------------------

function Value({ data }: { data: Insights }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const locations = useLocations();
  const nameOf = useLocationName();
  const { locations: locs, hiddenIn } = data.value;
  const currencies = currenciesOf(
    locs.flatMap((l) => [l.byCurrency, ...l.places.map((p) => p.byCurrency)]),
  );
  const { currency, setPicked } = useCurrency(currencies);
  // One scale per measure across the section: amounts where money shows, things where it doesn't.
  const maxAmount = Math.max(
    0,
    ...locs.flatMap((l) => l.places.map((p) => Number(amountIn(p.byCurrency, currency) ?? 0))),
  );
  const maxThings = Math.max(
    0,
    ...locs.filter((l) => l.moneyHidden).flatMap((l) => l.places.map((p) => p.things)),
  );
  // A location with nothing in use has nothing to draw: it's left out, not shown empty.
  const withThings = locs.filter((l) => l.things > 0);
  const several = withThings.length > 1;

  return (
    <Section title={<Trans>Value by place</Trans>}>
      <div className="grid min-w-0 gap-3">
        <CurrencySwitch currencies={currencies} value={currency} onChange={setPicked} />
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Each thing in use at its latest valuation. Things without one count, but add nothing.
          </Trans>
        </p>
        {withThings.length === 0 ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>No things yet.</Trans>
          </p>
        ) : null}
        {withThings.map((l) => {
          const loc = locations.data?.find((x) => x.id === l.locationId);
          const shown = !l.moneyHidden;
          const totals = (l.byCurrency ?? []).map((a) => money(a.amount, a.currency)).join(fmt.sep);
          return (
            <div key={l.locationId} className={card} data-location={l.locationId}>
              <div className="grid gap-0.5">
                {several ? (
                  <h3 className="m-0 font-semibold text-[15px] text-ink">
                    <bdi>{loc ? nameOf(loc) : ''}</bdi>
                  </h3>
                ) : null}
                <div className="text-small text-ink-2">
                  {shown ? (
                    <>
                      {totals ? (
                        <span className="font-semibold text-ink tabular-nums">
                          <bdi>{totals}</bdi>
                        </span>
                      ) : null}
                      {totals ? fmt.sep : null}
                      <span>
                        <Trans>
                          Valued: {fmt.num(l.valued ?? 0)} of {fmt.num(l.things)} things
                        </Trans>
                      </span>
                    </>
                  ) : (
                    <Plural value={l.things} one="# thing" other="# things" />
                  )}
                </div>
              </div>
              <ul className="m-0 grid list-none gap-2.5 p-0">
                {l.places.map((p) => {
                  const amount = amountIn(p.byCurrency, currency);
                  const measure = shown ? Number(amount ?? 0) : p.things;
                  const max = shown ? maxAmount : maxThings;
                  const pct = max > 0 ? (measure / max) * 100 : 0;
                  const name = p.unplaced
                    ? t`Unplaced`
                    : p.id === null
                      ? t`Other places (${fmt.num(p.others ?? 0)})`
                      : (p.name ?? '');
                  return (
                    <li key={p.id ?? 'other'} className="grid gap-1" data-place={p.id ?? 'other'}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        {p.id && !p.unplaced ? (
                          <Link
                            to="/p/$id"
                            params={{ id: addressOf({ id: p.id, shortCode: p.shortCode }) }}
                            className={link}
                          >
                            <bdi>{name}</bdi>
                          </Link>
                        ) : (
                          <span className="text-ink [overflow-wrap:anywhere]">
                            <bdi>{name}</bdi>
                          </span>
                        )}
                        <span className="text-small text-ink-2 tabular-nums">
                          {shown ? (
                            <>
                              <bdi className="font-semibold text-ink">
                                {money(amount ?? '0', currency)}
                              </bdi>
                              {fmt.sep}
                              <Trans>
                                {fmt.num(p.valued ?? 0)} of {fmt.num(p.things)} valued
                              </Trans>
                            </>
                          ) : (
                            <Plural value={p.things} one="# thing" other="# things" />
                          )}
                        </span>
                      </div>
                      <div aria-hidden="true" className="h-2 rounded-full bg-sunken">
                        <div
                          className="h-2 rounded-full"
                          style={{ inlineSize: `${pct}%`, background: 'var(--s1)' }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        <HiddenNotice ids={hiddenIn} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Vehicle costs
// ---------------------------------------------------------------------------------------------

function useCostLabels(): Record<CostKey, string> {
  const { t } = useLingui();
  return { fuel: t`Fuel`, service: t`Service & parts`, fees: t`Fees & insurance` };
}

function Vehicles({
  data,
  thisYear,
}: {
  data: NonNullable<Insights['vehicles']>;
  thisYear: number;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const n = useNumbers();
  const labels = useCostLabels();
  const currencies = currenciesOf([
    ...data.months.map((m) => m.byCurrency),
    ...data.items.flatMap((v) => v.years.map((y) => y.byCurrency)),
  ]);
  const { currency, setPicked } = useCurrency(currencies);
  const rowOf = (list: readonly CostAmounts[] | undefined) =>
    list?.find((c) => c.currency === currency);
  const text = (amount: string | undefined) => money(amount ?? '0', currency);
  const series: BarSeries[] = COST_KEYS.map((k) => ({
    key: k,
    label: labels[k],
    colour: COST_COLOUR[k],
  }));
  const first = data.months[0]?.month ?? '';
  const last = data.months.at(-1)?.month ?? '';
  const period = first ? `${n.monthCell(first)}–${n.monthCell(last)}` : '';
  // Twelve month names don't fit a phone's width: every other one is named there, the last
  // always; each bar's tooltip and the table still name its month.
  const wide = useMediaQuery(WIDE);
  const lastIndex = data.months.length - 1;
  const chartData = data.months.map((m, i) => {
    const row = rowOf(m.byCurrency);
    return {
      key: m.month,
      tick: wide || (lastIndex - i) % 2 === 0 ? n.monthTick(m.month) : '',
      title: n.monthTitle(m.month),
      values: Object.fromEntries(COST_KEYS.map((k) => [k, Number(row?.[k] ?? 0)])),
      texts: Object.fromEntries(COST_KEYS.map((k) => [k, text(row?.[k])])),
      totalText: text(row?.total),
    };
  });
  const years = [thisYear - 2, thisYear - 1, thisYear];

  return (
    <Section title={<Trans>Vehicle costs</Trans>}>
      <div className="grid min-w-0 gap-3">
        {data.items.length === 0 ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>No vehicles yet.</Trans>
          </p>
        ) : null}
        {currencies.length ? (
          <>
            <CurrencySwitch currencies={currencies} value={currency} onChange={setPicked} />
            <div className={card}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-semibold text-[14px] text-ink">
                  <Trans>Running cost per month, {currency}</Trans>
                </span>
                <span className="text-small text-ink-3">{period}</span>
              </div>
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
              <BarsChart
                data={chartData}
                series={series}
                label={t`Running cost per month. Arrow keys move between months and categories.`}
                totalLabel={t`Total`}
                tick={n.tick}
              />
            </div>
            <ChartTable
              caption={t`Running cost per month, ${currency}`}
              columns={[
                { key: 'month', label: <Trans>Month</Trans> },
                ...COST_KEYS.map((k) => ({ key: k, label: labels[k], numeric: true })),
                { key: 'total', label: <Trans>Total</Trans>, numeric: true },
              ]}
              rows={data.months.map((m) => {
                const row = rowOf(m.byCurrency);
                return {
                  key: m.month,
                  cells: {
                    month: n.monthCell(m.month),
                    ...Object.fromEntries(COST_KEYS.map((k) => [k, text(row?.[k])])),
                    total: text(row?.total),
                  },
                };
              })}
            />
          </>
        ) : null}
        {data.items.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-small" data-vehicle-years="">
              <caption className="sr-only">
                {currencies.length
                  ? t`Each vehicle per year, ${currency}`
                  : t`Each vehicle per year`}
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="border-b border-line px-2 py-1.5 text-start font-semibold text-ink-2"
                  >
                    <Trans>Vehicle</Trans>
                  </th>
                  {years.map((y) => (
                    <th
                      key={y}
                      scope="col"
                      className="border-b border-line px-2 py-1.5 text-end font-semibold text-ink-2"
                    >
                      {y === thisYear ? t`${n.year(y)} so far` : n.year(y)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((v) => (
                  <tr key={v.id} data-row={v.id}>
                    <th
                      scope="row"
                      className="border-b border-line px-2 py-1.5 text-start font-normal"
                    >
                      <Link
                        to="/t/$id"
                        params={{ id: addressOf(v) }}
                        search={{ tab: 'costs' }}
                        className={link}
                      >
                        <bdi>{v.name ?? ''}</bdi>
                      </Link>
                      {v.ended ? (
                        <span className="ms-1.5 text-ink-3">
                          <Trans>(no longer in use)</Trans>
                        </span>
                      ) : null}
                    </th>
                    {years.map((year) => {
                      const y = v.years.find((x) => x.year === year);
                      return (
                        <td
                          key={year}
                          className="border-b border-line px-2 py-1.5 text-end text-ink tabular-nums"
                        >
                          {v.moneyHidden || !currencies.length ? (
                            t`Fills: ${fmt.num(y?.fills ?? 0)}, services: ${fmt.num(y?.services ?? 0)}`
                          ) : (
                            <bdi>{text(rowOf(y?.byCurrency)?.total)}</bdi>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {data.more > 0 ? (
          <Link to="/vehicles" className={`${link} text-small`}>
            <Trans>See all vehicles ({fmt.num(data.more)} more)</Trans>
          </Link>
        ) : null}
        <HiddenNotice ids={data.hiddenIn} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Warranty coverage
// ---------------------------------------------------------------------------------------------

function Warranties({
  data,
  several,
}: {
  data: NonNullable<Insights['warranties']>;
  several: boolean;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const n = useNumbers();
  const locations = useLocations();
  const nameOf = useLocationName();
  const parts = [
    { key: 'covered', label: t`Under warranty`, n: data.covered, colour: 'var(--s1)' },
    { key: 'expiring', label: t`Ending soon`, n: data.expiring, colour: 'var(--s2)' },
    { key: 'ended', label: t`Cover ended`, n: data.ended, colour: 'var(--s3)' },
    { key: 'none', label: t`No warranty`, n: data.none, colour: 'var(--s-other)' },
  ];
  const pctOf = (x: number) => (data.things > 0 ? (x / data.things) * 100 : 0);

  return (
    <Section title={<Trans>Warranty coverage</Trans>}>
      <div className="grid min-w-0 gap-3">
        {data.things === 0 ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>No things yet.</Trans>
          </p>
        ) : (
          <div className={card}>
            <span className="font-semibold text-[14px] text-ink">
              <Trans>
                Covered now: {fmt.num(data.covered + data.expiring)} of {fmt.num(data.things)}{' '}
                things
              </Trans>
            </span>
            <div aria-hidden="true" className="flex h-3 overflow-hidden rounded-full bg-sunken">
              {parts.map((p) =>
                p.n > 0 ? (
                  <div key={p.key} style={{ inlineSize: `${pctOf(p.n)}%`, background: p.colour }} />
                ) : null,
              )}
            </div>
            <ul className="m-0 grid list-none gap-1 p-0 text-small sm:grid-cols-2">
              {parts.map((p) => (
                <li key={p.key} data-part={p.key} className="flex items-center gap-1.5 text-ink-2">
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 shrink-0 rounded-sm"
                    style={{ background: p.colour }}
                  />
                  <span>
                    {p.label}: <span className="text-ink tabular-nums">{fmt.num(p.n)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.expiringSoon.length ? (
          <div className={card}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-semibold text-[14px] text-ink">
                <Trans>Ending soon</Trans>
              </span>
              <Link
                to="/expiring"
                search={{ 'f.source': ['warranty'] }}
                className={`${link} text-small text-ink-2`}
              >
                <Trans>See all on Expiring</Trans>
              </Link>
            </div>
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {data.expiringSoon.map((w) => {
                const loc = locations.data?.find((l) => l.id === w.locationId);
                return (
                  <li key={w.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="min-w-0">
                      <Link to="/t/$id" params={{ id: addressOf(w) }} className={link}>
                        <bdi>{w.name ?? ''}</bdi>
                      </Link>
                      {several && loc ? (
                        <span className="text-small text-ink-3">
                          {fmt.sep}
                          <bdi>{nameOf(loc)}</bdi>
                        </span>
                      ) : null}
                    </span>
                    <span className="text-small text-ink-2">
                      <Trans>Ends {fmt.day(w.endsOn)}</Trans>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <ul className="m-0 grid list-none gap-1 p-0 text-small text-ink-2">
          {data.repairs.map((r) => {
            const year = r.soFar ? t`${n.year(r.year)} so far` : n.year(r.year);
            const costs = (r.byCurrency ?? [])
              .map(
                (c) =>
                  t`cost ${money(c.cost, c.currency)}, covered ${money(c.covered, c.currency)}`,
              )
              .join(fmt.sep);
            return (
              <li key={r.year} data-repairs={r.year}>
                <span>
                  <Trans>
                    Repairs resolved, {year}: {fmt.num(r.resolved)}
                  </Trans>
                </span>
                {costs ? (
                  <>
                    {fmt.sep}
                    <bdi>{costs}</bdi>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
        <HiddenNotice ids={data.hiddenIn} />
      </div>
    </Section>
  );
}
