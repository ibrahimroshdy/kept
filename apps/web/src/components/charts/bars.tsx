/**
 * Stacked monthly bars (plan T18; D133, V38): a vehicle's running costs by month, one bar a month,
 * one segment a category (fuel · service and parts · fees and insurance), in one currency. A month
 * with a note (a service's summary) gets a direct label above its bar. Loaded on demand with the
 * Costs tab (./lazy.tsx); the RTL, keyboard and tooltip rules are in ./kit.tsx.
 */
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear } from '@visx/scale';
import { BarStack } from '@visx/shape';
import { useTooltip } from '@visx/tooltip';
import type { KeyboardEvent } from 'react';
import { FALLBACK_WIDTH, SVG_STYLE, type Tip, TipBox, timeKeys, useRoving, useRtl } from './kit';

export type BarSeries = { key: string; label: string; colour: string };
export type BarDatum = {
  key: string;
  /** The axis's short label ("Apr"). */
  tick: string;
  /** The tooltip's title ("April 2026"). */
  title: string;
  values: Record<string, number>;
  /** Each series' amount as text, the same strings the table shows. */
  texts: Record<string, string>;
  totalText: string;
  /** A direct label above the bar (a service month's summary). */
  note?: string;
};

export type BarsProps = {
  data: BarDatum[];
  series: BarSeries[];
  /** The `<svg>`'s name, with how to move ("…; arrow keys move between months"). */
  label: string;
  totalLabel: string;
  /** A value tick ("2k", "٢ ألف"). */
  tick: (n: number) => string;
  height?: number;
};

type Mark = { m: number; s: number; id: string };

function Chart({
  width,
  data,
  series,
  label,
  totalLabel,
  tick,
  height = 220,
}: BarsProps & { width: number }) {
  const rtl = useRtl();
  const gutter = 52;
  const top = 22;
  const bottom = 28;
  const innerW = Math.max(0, width - gutter - 8);
  const innerH = height - top - bottom;
  const keys = series.map((s) => s.key);
  const x = scaleBand<string>({
    domain: data.map((d) => d.key),
    range: rtl ? [innerW, 0] : [0, innerW],
    padding: 0.3,
  });
  const totals = data.map((d) => keys.reduce((a, k) => a + (d.values[k] ?? 0), 0));
  const y = scaleLinear<number>({
    domain: [0, Math.max(1, ...totals)],
    range: [innerH, 0],
    nice: true,
  });
  const plotLeft = rtl ? 8 : gutter;
  const marks: Mark[] = [];
  data.forEach((d, m) => {
    keys.forEach((k, s) => {
      if ((d.values[k] ?? 0) > 0) marks.push({ m, s, id: `${m}:${s}` });
    });
  });
  const roving = useRoving(marks[0]?.id ?? '0:0');
  const tip = useTooltip<Tip>();
  const colour = Object.fromEntries(series.map((s) => [s.key, s.colour]));
  const tipFor = (m: number, s: number): Tip => {
    const d = data[m] as BarDatum;
    const ser = series[s] as BarSeries;
    return {
      title: d.title,
      lines: [`${ser.label}: ${d.texts[ser.key] ?? ''}`, `${totalLabel}: ${d.totalText}`],
    };
  };

  const onKey = (e: KeyboardEvent) => {
    const cur = marks.find((mk) => mk.id === roving.active);
    if (!cur) return;
    const { later, earlier } = timeKeys(rtl);
    const inMonth = (m: number) => marks.filter((mk) => mk.m === m);
    const nearest = (list: Mark[]) =>
      list.reduce<Mark | undefined>(
        (best, mk) => (!best || Math.abs(mk.s - cur.s) < Math.abs(best.s - cur.s) ? mk : best),
        undefined,
      );
    let next: Mark | undefined;
    if (e.key === later || e.key === earlier) {
      const step = e.key === later ? 1 : -1;
      for (let m = cur.m + step; m >= 0 && m < data.length && !next; m += step)
        next = nearest(inMonth(m));
    } else if (e.key === 'ArrowUp') next = inMonth(cur.m).find((mk) => mk.s > cur.s);
    else if (e.key === 'ArrowDown') next = [...inMonth(cur.m)].reverse().find((mk) => mk.s < cur.s);
    else if (e.key === 'Home') next = marks[0];
    else if (e.key === 'End') next = marks[marks.length - 1];
    else return;
    e.preventDefault();
    if (next) roving.move(next.id);
  };

  const rows = data.map((d) => ({ key: d.key, ...d.values }));
  return (
    <div className="relative">
      {/* biome-ignore lint/a11y/useSemanticElements: an SVG chart is a group of marks, not a form */}
      <svg width={width} height={height} style={SVG_STYLE} role="group" aria-label={label}>
        <Group left={plotLeft} top={top}>
          {y.ticks(4).map((v) => (
            <line key={v} x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          ))}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the roving marks inside are the stops */}
          <g onKeyDown={onKey}>
            <BarStack<(typeof rows)[number], string>
              data={rows}
              keys={keys}
              x={(d) => d.key}
              xScale={x}
              yScale={y}
              color={(k) => colour[k] ?? 'var(--s-other)'}
            >
              {(stacks) =>
                stacks.flatMap((stack) =>
                  stack.bars.map((bar) => {
                    const s = keys.indexOf(stack.key);
                    const id = `${bar.index}:${s}`;
                    if (bar.height <= 0 || (data[bar.index]?.values[stack.key] ?? 0) <= 0)
                      return null;
                    const tp = tipFor(bar.index, s);
                    const show = () =>
                      tip.showTooltip({
                        tooltipData: tp,
                        tooltipLeft: plotLeft + bar.x + bar.width / 2,
                        tooltipTop: top + bar.y,
                      });
                    return (
                      // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an SVG mark, one roving tab stop, named for its tooltip's words
                      <rect
                        key={id}
                        ref={(el) => {
                          roving.refs.current.set(id, el);
                        }}
                        data-mark={id}
                        role="img"
                        aria-label={`${tp.title}. ${tp.lines.join('. ')}`}
                        tabIndex={roving.active === id ? 0 : -1}
                        x={bar.x}
                        y={bar.y}
                        width={bar.width}
                        height={bar.height}
                        fill={bar.color}
                        className="outline-none focus-visible:stroke-[var(--ink)] focus-visible:stroke-2"
                        onFocus={() => {
                          roving.setActive(id);
                          show();
                        }}
                        onBlur={() => tip.hideTooltip()}
                        onPointerEnter={show}
                        onPointerLeave={() => tip.hideTooltip()}
                      />
                    );
                  }),
                )
              }
            </BarStack>
          </g>
          {data.map((d, i) =>
            d.note ? (
              <text
                key={d.key}
                x={(x(d.key) ?? 0) + x.bandwidth() / 2}
                y={y(totals[i] ?? 0) - 6}
                textAnchor="middle"
                fontSize={10.5}
                fill="var(--ink-2)"
              >
                {d.note}
              </text>
            ) : null,
          )}
          <AxisBottom
            top={innerH}
            scale={x}
            tickFormat={(k) => data.find((d) => d.key === k)?.tick ?? ''}
            stroke="var(--line)"
            tickStroke="var(--line)"
            tickLabelProps={{ fill: 'var(--ink-3)', fontSize: 11, textAnchor: 'middle' }}
          />
          {rtl ? (
            <AxisRight
              left={innerW}
              scale={y}
              numTicks={4}
              tickFormat={(v) => tick(Number(v))}
              stroke="var(--line)"
              tickStroke="var(--line)"
              tickLabelProps={{ fill: 'var(--ink-3)', fontSize: 11, textAnchor: 'start' }}
            />
          ) : (
            <AxisLeft
              scale={y}
              numTicks={4}
              tickFormat={(v) => tick(Number(v))}
              stroke="var(--line)"
              tickStroke="var(--line)"
              tickLabelProps={{ fill: 'var(--ink-3)', fontSize: 11 }}
            />
          )}
        </Group>
      </svg>
      {tip.tooltipOpen && tip.tooltipData ? (
        <TipBox tip={tip.tooltipData} x={tip.tooltipLeft ?? 0} y={tip.tooltipTop ?? 0} />
      ) : null}
    </div>
  );
}

export default function Bars(props: BarsProps) {
  const height = props.height ?? 220;
  // Without ResizeObserver (old browsers, tests) the chart takes a fixed width.
  if (typeof ResizeObserver === 'undefined') return <Chart {...props} width={FALLBACK_WIDTH} />;
  return (
    <ParentSize debounceTime={0} style={{ blockSize: height }}>
      {({ width }) => (width > 0 ? <Chart {...props} width={width} /> : null)}
    </ParentSize>
  );
}
