/**
 * The usage page's charts (D206, screens §5 AI usage §3), in the design board's chart style (the
 * series colours s1–s3 and "other"): tokens by day, stacked by task (photos and receipts,
 * assistant, search, tests); and tokens by task, model, person, location or account as bars. Each
 * has a table alternative behind "Show as a table" (§4), in the reader's digits. Days run with the
 * reading direction: right to gutter in Arabic. The day chart's `<svg>` is `direction: ltr` and
 * draws RTL by geometry (the V38 rule, docs/spikes/2026-09-30-step5-charts.md).
 */
import type { BudgetTask, LedgerTask } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useAiUsage } from '@/api/capture/queries';
import type { AiScope, AiUsageGroup, AiUsageGroupBy } from '@/api/capture/types';
import { ErrorState, Skeleton } from '@/components/page';
import { sep, useFormat } from '@/lib/format';
import { directionOf, usePrefs } from '@/lib/prefs';
import { AiDisclosure } from './disclosure';
import { useApproxCost, useTaskLabel, useTokens } from './labels';

const STACK: { task: BudgetTask; colour: string }[] = [
  { task: 'extraction', colour: 'var(--s1)' },
  { task: 'assistant', colour: 'var(--s2)' },
  { task: 'embeddings', colour: 'var(--s3)' },
  { task: 'test', colour: 'var(--s-other)' },
];

function useStackLabel(): (task: BudgetTask) => string {
  const { t } = useLingui();
  return (task) =>
    task === 'extraction'
      ? t`Photos and receipts`
      : task === 'assistant'
        ? t`Assistant`
        : task === 'embeddings'
          ? t`Search`
          : t`Tests`;
}

const tokensOf = (g: AiUsageGroup) => g.tokens.input + g.tokens.output;

/** Every UTC day from `from` up to `to` (or today), as YYYY-MM-DD. */
export function daysBetween(from: string, to: string, now = new Date()): string[] {
  const end = new Date(Math.min(new Date(to).getTime(), now.getTime()));
  const out: string[] = [];
  const d = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function ChartCard({
  title,
  note,
  legend,
  chart,
  table,
}: {
  title: ReactNode;
  note?: ReactNode;
  legend?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
}) {
  return (
    <section className="grid content-start gap-3 rounded-[10px] border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 font-semibold text-[15px] text-ink">{title}</h2>
        {note ? <span className="text-small text-ink-3">{note}</span> : null}
      </div>
      {legend}
      {chart}
      <AiDisclosure quiet title={<Trans>Show as a table</Trans>}>
        <div className="overflow-x-auto">{table}</div>
      </AiDisclosure>
    </section>
  );
}

const th = 'border-line border-b py-1.5 pe-3 text-end font-semibold first:text-start';
// Cells never wrap: the table scrolls sideways on a phone, and "Sep / 26", "≈ USD / 0.0030" or
// "qwen/qwen3.8- / 27b" broken inside a cell read wrong (the phone pass).
const td =
  'border-line border-b py-1.5 pe-3 text-end tabular-nums whitespace-nowrap first:text-start';

function Legend() {
  const label = useStackLabel();
  return (
    <div aria-hidden="true" className="flex flex-wrap gap-3.5 text-[12.5px] text-ink-2">
      {STACK.map((s) => (
        <span key={s.task} className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-[2px]" style={{ background: s.colour }} />
          {label(s.task)}
        </span>
      ))}
    </div>
  );
}

/** Tokens by day, stacked by task. */
export function DayChart({
  scope,
  locationId,
  from,
  to,
  soFar,
}: {
  scope: AiScope;
  locationId?: string;
  from: string;
  to: string;
  soFar: boolean;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const tokens = useTokens();
  const approx = useApproxCost();
  const stackLabel = useStackLabel();
  const { locale } = usePrefs();
  const rtl = directionOf(locale) === 'rtl';
  const q = useAiUsage({ scope, ...(locationId ? { locationId } : {}), from, to, groupBy: 'day' });
  if (q.isPending) return <Skeleton className="h-56" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const byDay = new Map(q.data.groups.map((g) => [g.key.slice(0, 10), g]));
  const days = daysBetween(from, to);
  const max = Math.max(
    1,
    ...days.map((d) => (byDay.get(d) ? tokensOf(byDay.get(d) as AiUsageGroup) : 0)),
  );
  const W = 560;
  const H = 200;
  const ticks = [0, max / 2, max];
  // The value labels' gutter fits the longest one: "١٠٫٦ ألف" is wider than "10.6k".
  const gutter = Math.max(44, 14 + 6 * Math.max(...ticks.map((v) => tokens(v).length)));
  const bottom = 176;
  const top = 12;
  const slot = (W - gutter - 8) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(18, slot * 0.7));
  const y = (v: number) => bottom - ((bottom - top) * v) / max;
  const x = (i: number) => {
    const pos = gutter + slot * i + (slot - bar) / 2;
    // Mirrored across the whole width, so the plot spans 8…W−gutter and the gutter is on the right.
    return rtl ? W - pos - bar : pos;
  };
  return (
    <ChartCard
      title={<Trans>Tokens by day</Trans>}
      note={soFar ? <Trans>so far</Trans> : undefined}
      legend={<Legend />}
      chart={
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t`Tokens by day, stacked by task`}
          className="block h-auto w-full"
          // V38: SVG text-anchor follows the inherited `direction`, so under an Arabic page
          // `start` ran the value labels leftwards into the bars. The SVG is always LTR and RTL is
          // drawn by geometry: days run right to left, the value labels sit in the right gutter.
          style={{ direction: 'ltr' }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={rtl ? 8 : gutter}
                x2={rtl ? W - gutter : W - 8}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--line)"
              />
              <text
                x={rtl ? W - gutter + 6 : gutter - 6}
                y={y(v) + 4}
                textAnchor={rtl ? 'start' : 'end'}
                fontSize="11"
                fill="var(--ink-3)"
              >
                {tokens(v)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const g = byDay.get(d);
            let acc = 0;
            return (
              <g key={d}>
                {g
                  ? STACK.map((s) => {
                      const v = g.tasks?.[s.task]?.tokens ?? 0;
                      if (!v) return null;
                      const y0 = y(acc);
                      acc += v;
                      return (
                        <rect
                          key={s.task}
                          x={x(i)}
                          y={y(acc)}
                          width={bar}
                          height={Math.max(0, y0 - y(acc))}
                          fill={s.colour}
                        />
                      );
                    })
                  : null}
              </g>
            );
          })}
          {days.length > 0 ? (
            <>
              {/* The first and last days line up with the plot's outer edges, inside the SVG. */}
              <text
                x={rtl ? x(0) + bar : x(0)}
                y={H - 6}
                textAnchor={rtl ? 'end' : 'start'}
                fontSize="11"
                fill="var(--ink-3)"
              >
                {fmt.day(`${days[0]}T12:00:00Z`)}
              </text>
              {days.length > 1 ? (
                <text
                  x={rtl ? x(days.length - 1) : x(days.length - 1) + bar}
                  y={H - 6}
                  textAnchor={rtl ? 'start' : 'end'}
                  fontSize="11"
                  fill="var(--ink-3)"
                >
                  {fmt.day(`${days[days.length - 1]}T12:00:00Z`)}
                </text>
              ) : null}
            </>
          ) : null}
        </svg>
      }
      table={
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={th}>
                <Trans>Day</Trans>
              </th>
              {STACK.map((s) => (
                <th key={s.task} className={th}>
                  {stackLabel(s.task)}
                </th>
              ))}
              <th className={th}>
                <Trans>Calls</Trans>
              </th>
              <th className={th}>
                <Trans>Cost</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {days
              .filter((d) => byDay.has(d))
              .map((d) => {
                const g = byDay.get(d) as AiUsageGroup;
                return (
                  <tr key={d}>
                    <td className={td}>{fmt.day(`${d}T12:00:00Z`)}</td>
                    {STACK.map((s) => (
                      <td key={s.task} className={td}>
                        {fmt.num(g.tasks?.[s.task]?.tokens ?? 0)}
                      </td>
                    ))}
                    <td className={td}>{fmt.num(g.calls)}</td>
                    <td className={td}>
                      {g.cost.map((c) => approx(c.amount, c.currency)).join(sep()) || '–'}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      }
    />
  );
}

/** Tokens per group (task, model, person, location, account), as bars with a table. */
export function GroupChart({
  scope,
  locationId,
  from,
  to,
  groupBy,
  title,
}: {
  scope: AiScope;
  locationId?: string;
  from: string;
  to: string;
  groupBy: Exclude<AiUsageGroupBy, 'day'>;
  title: ReactNode;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const tokens = useTokens();
  const approx = useApproxCost();
  const taskLabel = useTaskLabel();
  const q = useAiUsage({ scope, ...(locationId ? { locationId } : {}), from, to, groupBy });
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const name = (g: AiUsageGroup) =>
    groupBy === 'task'
      ? taskLabel(g.key as LedgerTask)
      : groupBy === 'person' && g.key === 'background'
        ? t`Kept (background)`
        : g.label || t`No location`;
  const groups = [...q.data.groups].sort((a, b) => tokensOf(b) - tokensOf(a));
  const max = Math.max(1, ...groups.map(tokensOf));
  if (groups.length === 0) return null;
  return (
    <ChartCard
      title={title}
      chart={
        <ul aria-hidden="true" className="m-0 grid list-none gap-2 p-0">
          {groups.map((g) => (
            <li key={g.key} className="grid gap-1">
              <span className="flex flex-wrap justify-between gap-2 text-small">
                {groupBy === 'model' && g.key ? (
                  // A model ID is one token (UI audit L2): it moves to its own line whole.
                  <bdi dir="ltr" className="model-id font-mono text-[12.5px] text-ink">
                    {name(g)}
                  </bdi>
                ) : (
                  <bdi className="text-ink [overflow-wrap:anywhere]">{name(g)}</bdi>
                )}
                <span className="text-ink-2 tabular-nums">{tokens(tokensOf(g))}</span>
              </span>
              <span className="h-2 rounded-full bg-sunken">
                <span
                  className="block h-full rounded-full"
                  style={{ inlineSize: `${(tokensOf(g) / max) * 100}%`, background: 'var(--s1)' }}
                />
              </span>
            </li>
          ))}
        </ul>
      }
      table={
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={th}>{title}</th>
              <th className={th}>
                <Trans>Calls</Trans>
              </th>
              <th className={th}>
                <Trans>Tokens</Trans>
              </th>
              <th className={th}>
                <Trans>Images</Trans>
              </th>
              <th className={th}>
                <Trans>Cost</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td className={td}>
                  <bdi>{name(g)}</bdi>
                </td>
                <td className={td}>{fmt.num(g.calls)}</td>
                <td className={td}>{fmt.num(tokensOf(g))}</td>
                <td className={td}>{fmt.num(g.images)}</td>
                <td className={td}>
                  {g.cost.map((c) => approx(c.amount, c.currency)).join(sep()) || '–'}
                  {g.unknownCostCalls > 0 ? (
                    <>
                      {sep()}
                      <Trans>{fmt.num(g.unknownCostCalls)} unknown</Trans>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}
