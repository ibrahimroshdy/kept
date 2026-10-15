/**
 * Home's Insights teaser (D240; D234): only where Money is on and shows to you, and only once
 * something was bought or valued (`/home/overview`'s `insights`, null otherwise).
 *
 * - **Spent on things, this year so far,** one line per currency, with this year and the three
 *   before it as small bars on that currency's own scale (this year hatched: it is not over).
 * - **Value of what you own,** one line per currency, and how many things have a value.
 * - One currency per line, never added across currencies or converted (D76). The figures are
 *   Insights' own (the server sums them the same way), and the foot names the locations they
 *   leave out: Money off there, or money hidden from you there.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { HomeOverview, OverviewAmount } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { useMoney } from '@/components/things/values';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { HomeSection, SectionLink } from './section';

type Teaser = NonNullable<HomeOverview['insights']>;

const amountIn = (list: readonly OverviewAmount[], currency: string) =>
  Number(list.find((a) => a.currency === currency)?.amount ?? 0);

function MiniBars({ years, currency }: { years: Teaser['years']; currency: string }) {
  const f = useFormat();
  const max = Math.max(1, ...years.map((y) => amountIn(y.byCurrency, currency)));
  return (
    <span aria-hidden="true" className="flex h-11 items-end gap-1.5">
      {years.map((y) => (
        <span
          key={y.year}
          className="grid justify-items-center gap-[3px] font-mono font-medium text-[10px] text-ink-3 leading-none"
        >
          <span
            className={cn(
              'block w-4 rounded-t-[3px] bg-s1',
              y.soFar &&
                'bg-[repeating-linear-gradient(135deg,var(--s1)_0_3px,color-mix(in_srgb,var(--s1)_45%,var(--surface))_3px_6px)]',
            )}
            style={{ height: `${Math.round((amountIn(y.byCurrency, currency) / max) * 30) + 2}px` }}
          />
          <span className="ltr">{f.num(y.year % 100).padStart(2, f.num(0))}</span>
        </span>
      ))}
    </span>
  );
}

export function InsightsTeaser({ insights, className }: { insights: Teaser; className?: string }) {
  const { t } = useLingui();
  const f = useFormat();
  const money = useMoney();
  const locations = useLocations().data ?? [];
  const nameOf = useLocationName();
  const nameList = (ids: readonly string[]) =>
    ids
      .map((id) => locations.find((l) => l.id === id))
      .flatMap((l) => (l ? [nameOf(l)] : []))
      .join(f.sep);
  const now = insights.years.find((y) => y.soFar);
  const spentIn = [
    ...new Set(insights.years.flatMap((y) => y.byCurrency.map((a) => a.currency))),
  ].sort();
  const year = insights.thisYear;
  const off = nameList(insights.moneyOff);
  const names = nameList(insights.hiddenIn);
  const count = f.num(insights.value.valued);
  const total = f.num(insights.value.things);
  return (
    <HomeSection
      title={<Trans>Insights</Trans>}
      action={
        <SectionLink to="/insights">
          <Trans>Open</Trans>
        </SectionLink>
      }
      className={className}
    >
      <div className="grid overflow-hidden rounded-xl border border-line bg-surface [&>*+*]:border-t [&>*+*]:border-line">
        {spentIn.length > 0 ? (
          <div className="grid gap-1 px-3.5 py-3">
            <span className="text-[12.5px] text-ink-2">
              <Trans>Spent on things, {year} so far</Trans>
            </span>
            {spentIn.map((c) => (
              <div key={c} className="flex flex-wrap items-end justify-between gap-3">
                <bdi className="font-semibold text-[20px] leading-[1.2] tabular-nums [overflow-wrap:anywhere]">
                  {money(String(amountIn(now?.byCurrency ?? [], c)), c)}
                </bdi>
                <MiniBars years={insights.years} currency={c} />
              </div>
            ))}
          </div>
        ) : null}
        {insights.value.byCurrency.length > 0 ? (
          <div className="grid gap-1 px-3.5 py-3">
            <span className="text-[12.5px] text-ink-2">
              <Trans>Value of what you own</Trans>
            </span>
            {insights.value.byCurrency.map((a) => (
              <bdi
                key={a.currency}
                className="font-semibold text-[20px] leading-[1.2] tabular-nums [overflow-wrap:anywhere]"
              >
                {money(a.amount, a.currency)}
              </bdi>
            ))}
            <span className="text-[12.5px] text-ink-3">
              {t`${count} of ${total} things have a value`}
            </span>
          </div>
        ) : null}
        {off || names ? (
          <div className="grid gap-1 px-3.5 py-2.5 text-[12.5px] text-ink-3">
            {off ? <span>{t`Leaves out ${off}: Money is off there.`}</span> : null}
            {names ? (
              <span>{t`Amounts leave out ${names}: money is hidden from you there.`}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </HomeSection>
  );
}
