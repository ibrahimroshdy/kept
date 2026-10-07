/**
 * A meter's readings over time (plan T18; D52, D133, V38): the readings as a line, the usage
 * estimate dashed from the latest reading to the next threshold, and each schedule's threshold as
 * a faint rule with its name. Loaded on demand with the Readings tab (./lazy.tsx); the RTL,
 * keyboard and tooltip rules are in ./kit.tsx.
 */
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear, scaleUtc } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { useTooltip } from '@visx/tooltip';
import type { KeyboardEvent } from 'react';
import { FALLBACK_WIDTH, SVG_STYLE, type Tip, TipBox, timeKeys, useRoving, useRtl } from './kit';

export type SeriesPoint = {
  key: string;
  /** An instant (ISO). */
  at: string;
  value: number;
  /** The tooltip's title and the table's date ("2 Oct", "estimated ~14 Nov"). */
  title: string;
  /** The value with its unit, as the table shows it. */
  valueText: string;
  /** A second line ("From a photo"). */
  detail?: string;
  estimate?: boolean;
};
export type SeriesThreshold = { key: string; value: number; label: string };

export type SeriesProps = {
  points: SeriesPoint[];
  thresholds?: SeriesThreshold[];
  label: string;
  /** A value tick ("52,000"). */
  tick: (n: number) => string;
  /** A time tick ("May"). */
  timeTick: (d: Date) => string;
  height?: number;
};

const DAY = 86_400_000;

function Chart({
  width,
  points,
  thresholds = [],
  label,
  tick,
  timeTick,
  height = 200,
}: SeriesProps & { width: number }) {
  const rtl = useRtl();
  const gutter = 60;
  const top = 12;
  const bottom = 28;
  const innerW = Math.max(0, width - gutter - 16);
  const innerH = height - top - bottom;
  const times = points.map((p) => new Date(p.at).getTime());
  const first = Math.min(...times);
  const last = Math.max(...times);
  // A little room either side, so the first point doesn't sit on the value axis (the spike's note).
  const pad = Math.max(DAY, (last - first) * 0.03);
  const x = scaleUtc<number>({
    domain: [new Date(first - pad), new Date(last + pad)],
    range: rtl ? [innerW, 0] : [0, innerW],
  });
  const values = [...points.map((p) => p.value), ...thresholds.map((t) => t.value)];
  const y = scaleLinear<number>({
    domain: [Math.min(...values), Math.max(...values)],
    range: [innerH, 0],
    nice: true,
  });
  const plotLeft = rtl ? 16 : gutter;
  const actual = points.filter((p) => !p.estimate);
  const estimate = points.filter((p) => p.estimate);
  const lastActual = actual[actual.length - 1];
  const roving = useRoving(points[0]?.key ?? '');
  const tip = useTooltip<Tip>();
  const tipFor = (p: SeriesPoint): Tip => ({
    title: p.title,
    lines: [p.valueText, ...(p.detail ? [p.detail] : [])],
  });
  const onKey = (e: KeyboardEvent) => {
    const i = points.findIndex((p) => p.key === roving.active);
    const { later, earlier } = timeKeys(rtl);
    let n = i;
    if (e.key === later) n = Math.min(points.length - 1, i + 1);
    else if (e.key === earlier) n = Math.max(0, i - 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = points.length - 1;
    else return;
    e.preventDefault();
    const next = points[n];
    if (next) roving.move(next.key);
  };
  const at = (p: SeriesPoint) => x(new Date(p.at)) ?? 0;

  return (
    <div className="relative">
      {/* biome-ignore lint/a11y/useSemanticElements: an SVG chart is a group of marks, not a form */}
      <svg width={width} height={height} style={SVG_STYLE} role="group" aria-label={label}>
        <Group left={plotLeft} top={top}>
          {y.ticks(4).map((v) => (
            <line key={v} x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          ))}
          {thresholds.map((t) => (
            <g key={t.key}>
              <line
                x1={0}
                x2={innerW}
                y1={y(t.value)}
                y2={y(t.value)}
                stroke="var(--ink-3)"
                strokeDasharray="2 3"
              />
              <text
                x={rtl ? innerW - 4 : 4}
                y={y(t.value) - 4}
                textAnchor={rtl ? 'end' : 'start'}
                fontSize={10.5}
                fill="var(--ink-2)"
              >
                {t.label}
              </text>
            </g>
          ))}
          <LinePath data={actual} x={at} y={(p) => y(p.value)} stroke="var(--s1)" strokeWidth={2} />
          {lastActual && estimate.length ? (
            <LinePath
              data={[lastActual, ...estimate]}
              x={at}
              y={(p) => y(p.value)}
              stroke="var(--s1)"
              strokeWidth={2}
              strokeDasharray="5 4"
              data-estimate=""
            />
          ) : null}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the roving marks inside are the stops */}
          <g onKeyDown={onKey}>
            {points.map((p) => {
              const tp = tipFor(p);
              const cx = at(p);
              const cy = y(p.value);
              const show = () =>
                tip.showTooltip({
                  tooltipData: tp,
                  tooltipLeft: plotLeft + cx,
                  tooltipTop: top + cy,
                });
              return (
                // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an SVG mark, one roving tab stop, named for its tooltip's words
                <circle
                  key={p.key}
                  ref={(el) => {
                    roving.refs.current.set(p.key, el);
                  }}
                  data-mark={p.key}
                  role="img"
                  aria-label={`${tp.title}. ${tp.lines.join('. ')}`}
                  tabIndex={roving.active === p.key ? 0 : -1}
                  cx={cx}
                  cy={cy}
                  r={4.5}
                  fill={p.estimate ? 'var(--surface)' : 'var(--s1)'}
                  stroke="var(--s1)"
                  strokeWidth={2}
                  className="outline-none focus-visible:stroke-[var(--ink)]"
                  onFocus={() => {
                    roving.setActive(p.key);
                    show();
                  }}
                  onBlur={() => tip.hideTooltip()}
                  onPointerEnter={show}
                  onPointerLeave={() => tip.hideTooltip()}
                />
              );
            })}
          </g>
          <AxisBottom
            top={innerH}
            scale={x}
            numTicks={Math.max(2, Math.min(6, Math.floor(innerW / 90)))}
            tickFormat={(d) => timeTick(d as Date)}
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

export default function Series(props: SeriesProps) {
  const height = props.height ?? 200;
  if (props.points.length === 0) return null;
  if (typeof ResizeObserver === 'undefined') return <Chart {...props} width={FALLBACK_WIDTH} />;
  return (
    <ParentSize debounceTime={0} style={{ blockSize: height }}>
      {({ width }) => (width > 0 ? <Chart {...props} width={width} /> : null)}
    </ParentSize>
  );
}
