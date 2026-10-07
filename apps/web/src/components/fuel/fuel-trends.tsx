/**
 * The Fuel tab's trends (plan T21; D133, V38): consumption per full-to-full interval, and the price
 * per unit per fill, each a line over time with "Show as table". A lazy chunk (fuel-tab.tsx loads
 * it with React.lazy), so the charts cost nothing until the tab is open.
 *
 * Drawn as plain SVG, the way the AI usage charts are (components/ai/usage-charts.tsx), by the V38
 * rules (docs/spikes/2026-09-30-step5-charts.md): the `<svg>` is `direction: ltr` and RTL is drawn
 * by geometry (time runs right to left, the value labels sit on the right); every point is
 * reachable from the keyboard as one tab stop (a roving tabIndex; the arrows move the way they
 * point on screen, Home and End to the ends), each point's label says what the line above the
 * chart says on focus or hover, and nothing animates, so reduced motion has nothing to stop.
 * Values and dates are in the reader's digits.
 */
import { displayConsumption, type FuelUnit } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { FuelSummary } from '@/api/vehicles/types';
import { AiDisclosure } from '@/components/ai/disclosure';
import { useMoney } from '@/components/things/values';
import { useFormat } from '@/lib/format';
import { directionOf, usePrefs } from '@/lib/prefs';
import { useConsumptionText, useDecimal, useFuelUnitShort, useUnitSystem } from './labels';

export type TrendPoint = { at: string; value: number; text: string };

const W = 560;
const H = 180;
const PAD = { top: 14, bottom: 26, side: 48, end: 12 };

export function TrendChart({
  title,
  points,
  tick,
  columns,
}: {
  title: string;
  points: TrendPoint[];
  /** A value-axis label ("7.3", "23.75"). */
  tick: (value: number) => string;
  /** The table's two column headings. */
  columns: [string, string];
}) {
  const { t } = useLingui();
  const f = useFormat();
  const { locale } = usePrefs();
  const rtl = directionOf(locale) === 'rtl';
  const [focused, setFocused] = useState<number | null>(null);
  const [roving, setRoving] = useState(Math.max(0, points.length - 1));
  const refs = useRef<(SVGCircleElement | null)[]>([]);
  const titleId = useId();
  if (points.length === 0) return null;

  const times = points.map((p) => Date.parse(p.at));
  const values = points.map((p) => p.value);
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  // A little room either side, so the first point never sits on the value axis (V38).
  const padT = Math.max((t1 - t0) * 0.04, 86_400_000);
  t0 -= padT;
  t1 += padT;
  let v0 = Math.min(...values);
  let v1 = Math.max(...values);
  if (v1 - v0 < 1e-9) {
    v0 -= Math.max(1, Math.abs(v0) * 0.1);
    v1 += Math.max(1, Math.abs(v1) * 0.1);
  } else {
    const m = (v1 - v0) * 0.12;
    v0 = Math.max(0, v0 - m);
    v1 += m;
  }
  // The plot between the value labels (inline start) and a small end margin.
  const left = rtl ? PAD.end : PAD.side;
  const right = rtl ? W - PAD.side : W - PAD.end;
  const x = (ms: number) => {
    const r = (ms - t0) / (t1 - t0);
    return rtl ? right - r * (right - left) : left + r * (right - left);
  };
  const y = (v: number) => PAD.top + (1 - (v - v0) / (v1 - v0)) * (H - PAD.top - PAD.bottom);
  const ticks = [v0, (v0 + v1) / 2, v1];
  const path = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${x(times[i] as number).toFixed(1)} ${y(p.value).toFixed(1)}`,
    )
    .join(' ');

  const move = (to: number) => {
    const i = Math.min(points.length - 1, Math.max(0, to));
    setRoving(i);
    setFocused(i);
    refs.current[i]?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    // The arrows move the way they point on screen: in Arabic, ← is later in time.
    const later = rtl ? 'ArrowLeft' : 'ArrowRight';
    const earlier = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === later) move(i + 1);
    else if (e.key === earlier) move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(points.length - 1);
    else return;
    e.preventDefault();
  };
  const shown = focused !== null ? points[focused] : null;
  const first = points[0] as TrendPoint;
  const last = points[points.length - 1] as TrendPoint;

  return (
    <figure className="m-0 grid min-w-0 gap-2">
      <figcaption id={titleId} className="font-semibold text-[14px] text-ink">
        {title}
      </figcaption>
      <p aria-hidden="true" className="m-0 min-h-5 text-small text-ink-2 tabular-nums">
        {shown ? `${f.day(shown.at)}: ${shown.text}` : null}
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: an SVG chart's marks, grouped and named (V38) */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-labelledby={titleId}
        aria-description={t`Use the arrow keys to move between points.`}
        className="h-auto w-full max-w-full overflow-visible text-ink-3"
        style={{ direction: 'ltr' }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text
              x={rtl ? right + 6 : left - 6}
              y={y(v) + 4}
              textAnchor={rtl ? 'start' : 'end'}
              fontSize="11"
              fill="currentColor"
            >
              {tick(v)}
            </text>
          </g>
        ))}
        <text
          x={x(times[0] as number)}
          y={H - 6}
          textAnchor="middle"
          fontSize="11"
          fill="currentColor"
        >
          {f.day(first.at)}
        </text>
        {points.length > 1 ? (
          <text
            x={x(times[times.length - 1] as number)}
            y={H - 6}
            textAnchor="middle"
            fontSize="11"
            fill="currentColor"
          >
            {f.day(last.at)}
          </text>
        ) : null}
        <path d={path} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" />
        {points.map((p, i) => (
          // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a mark is an image a keyboard can reach, one roving tab stop per chart (V38)
          <circle
            key={p.at}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="img"
            aria-label={`${f.day(p.at)}: ${p.text}`}
            tabIndex={i === roving ? 0 : -1}
            cx={x(times[i] as number)}
            cy={y(p.value)}
            r={focused === i ? 6 : 4}
            fill="var(--surface)"
            stroke="var(--s1)"
            strokeWidth="2"
            className="cursor-pointer outline-none focus-visible:stroke-[var(--info)]"
            onFocus={() => {
              setRoving(i);
              setFocused(i);
            }}
            onBlur={() => setFocused(null)}
            onMouseEnter={() => setFocused(i)}
            onMouseLeave={() => setFocused(null)}
            onKeyDown={(e) => onKey(e, i)}
          />
        ))}
      </svg>
      <AiDisclosure quiet title={<Trans>Show as table</Trans>}>
        <table className="w-full border-collapse text-small">
          <thead>
            <tr className="text-start text-ink-2">
              <th className="py-1 text-start font-medium">{columns[0]}</th>
              <th className="py-1 text-start font-medium">{columns[1]}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.at} className="border-t border-line">
                <td className="py-1">{f.day(p.at)}</td>
                <td className="py-1 tabular-nums">
                  <bdi>{p.text}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </AiDisclosure>
    </figure>
  );
}

/** Consumption per unit and price per unit and currency, one chart each. */
export default function FuelTrends({ summary }: { summary: FuelSummary }) {
  const { t } = useLingui();
  const consumptionText = useConsumptionText();
  const decimal = useDecimal();
  const money = useMoney();
  const short = useFuelUnitShort();
  const units = useUnitSystem();
  const charts: ReactNode[] = [];
  for (const u of summary.byUnit) {
    if (u.trend.length < 2 || !u.consumption) continue;
    const distanceUnit = u.consumption.distanceUnit;
    // The chart draws the figure the reader reads: in their units (mpg runs the other way).
    const shown = (perHundred: string) => consumptionText(perHundred, u.unit, distanceUnit);
    charts.push(
      <TrendChart
        key={`c-${u.unit}`}
        title={t`Consumption, ${short[u.unit]}`}
        points={u.trend.map((p) => ({
          at: p.at,
          value: Number(displayConsumption(p.perHundred, u.unit, distanceUnit, units).value),
          text: shown(p.perHundred),
        }))}
        tick={(v) => decimal(v, 1)}
        columns={[t`Full fill`, t`Consumption`]}
      />,
    );
  }
  if (!summary.moneyHidden)
    for (const p of summary.pricePerUnit ?? []) {
      if (p.trend.length < 2) continue;
      const unit: FuelUnit = p.unit;
      const u = short[unit];
      charts.push(
        <TrendChart
          key={`p-${p.unit}-${p.currency}`}
          title={t`Price per ${u}, ${p.currency}`}
          points={p.trend.map((x) => {
            const amount = money(x.price, p.currency);
            return { at: x.at, value: Number(x.price), text: t`${amount} per ${u}` };
          })}
          tick={(v) => decimal(v, 2)}
          columns={[t`Fill`, t`Price`]}
        />,
      );
    }
  if (charts.length === 0) return null;
  return <div className="grid gap-5 md:grid-cols-2">{charts}</div>;
}
