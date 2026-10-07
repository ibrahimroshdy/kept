// SPIKE (step 5, T0, V38). Throwaway. The vehicle's two chart shapes on @visx/* 4.0.0:
// - costs by month, three stacked series (fuel · service and parts · fees and insurance);
// - the odometer as a line, with the estimate as a dashed segment.
// What it proves (docs/spikes/2026-09-30-step5-charts.md):
// - RTL: the time axis runs right to left (the band and time scales get a reversed range) and the
//   value axis moves to the right; ticks are Intl ar-EG, so Eastern digits;
// - SVG text inherits CSS `direction`, which flips what `text-anchor: start|end` means; visx's
//   axes assume LTR anchors, so the <svg> is set to `direction: ltr` and mirrored by geometry
//   (?naive=1 leaves it inheriting, to measure the difference);
// - keyboard: one tab stop per chart (roving tabindex), arrows move between marks in the
//   direction they point on screen, the tooltip opens on focus as well as hover;
// - "Show as table" formats with the same functions, so the numbers are the same strings;
// - no motion: visx draws static SVG; the only transition is the tooltip's fade, and only under
//   `prefers-reduced-motion: no-preference`.
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear, scaleUtc } from '@visx/scale';
import { BarStack, LinePath } from '@visx/shape';
import { TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { COSTS, fmt, KEYS, type Key, L, type Lang, READINGS } from './data';

const COLOUR: Record<Key, string> = { fuel: 'var(--s1)', service: 'var(--s2)', fees: 'var(--s3)' };
const naive = new URLSearchParams(location.search).get('naive') === '1';
/** The <svg>'s own direction: LTR, so visx's text anchors mean what they say (see header). */
const svgStyle = naive ? { display: 'block' } : { display: 'block', direction: 'ltr' as const };

type Tip = { title: string; lines: string[] };

function TableToggle({ lang, id, children }: { lang: Lang; id: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const t = L[lang];
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? t.hideTable : t.showTable}
      </button>
      {open ? (
        <div id={id} style={{ overflowX: 'auto' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function TipBox({ tip, left, top }: { tip: Tip; left: number; top: number }) {
  return (
    <TooltipWithBounds
      left={left}
      top={top}
      unstyled
      applyPositionStyle
      className="tip"
      data-testid="tip"
      aria-hidden="true"
    >
      <strong>{tip.title}</strong>
      {tip.lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </TooltipWithBounds>
  );
}

/** Moves focus to the mark `key` once the active mark changes by keyboard. */
function useRoving<K extends string>(initial: K) {
  const [active, setActive] = useState<K>(initial);
  const refs = useRef(new Map<string, SVGElement | null>());
  const byKey = useRef(false);
  useEffect(() => {
    if (!byKey.current) return;
    byKey.current = false;
    (refs.current.get(active) as unknown as HTMLElement | undefined)?.focus();
  }, [active]);
  const move = (k: K) => {
    byKey.current = true;
    setActive(k);
  };
  return { active, setActive, move, refs };
}

// ---------------------------------------------------------------------------------------------
// Costs by month, stacked.

type Mark = { m: number; s: number; id: string };

function CostsChart({ width, lang }: { width: number; lang: Lang }) {
  const f = fmt(lang);
  const t = L[lang];
  const rtl = lang === 'ar';
  const height = 220;
  const gutter = 52; // the value axis' side
  const top = 12;
  const bottom = 28;
  const innerW = Math.max(0, width - gutter - 8);
  const innerH = height - top - bottom;
  const months = COSTS.map((r) => r.month);
  const x = scaleBand<string>({ domain: months, range: rtl ? [innerW, 0] : [0, innerW], padding: 0.3 });
  const max = Math.max(...COSTS.map((r) => KEYS.reduce((a, k) => a + r[k], 0)));
  const y = scaleLinear<number>({ domain: [0, max], range: [innerH, 0], nice: true });
  const plotLeft = rtl ? 8 : gutter;

  // Every visible segment is a stop; zero-height ones are not drawn as marks.
  const marks: Mark[] = [];
  COSTS.forEach((r, m) => {
    KEYS.forEach((k, s) => {
      if (r[k] > 0) marks.push({ m, s, id: `${m}:${s}` });
    });
  });
  const roving = useRoving(marks[0]?.id ?? '0:0');
  const tip = useTooltip<Tip>();

  const tipFor = (m: number, s: number): Tip => {
    const r = COSTS[m];
    const k = KEYS[s];
    const total = KEYS.reduce((a, kk) => a + r[kk], 0);
    return {
      title: f.monthYear(r.month),
      lines: [`${t[k]}: ${f.money(r[k])}`, `${t.total}: ${f.money(total)}`],
    };
  };

  const onKey = (e: KeyboardEvent) => {
    const cur = marks.find((mk) => mk.id === roving.active);
    if (!cur) return;
    // Arrows point where they go on screen: in RTL, right is earlier.
    const later = rtl ? 'ArrowLeft' : 'ArrowRight';
    const earlier = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: Mark | undefined;
    const inMonth = (m: number) => marks.filter((mk) => mk.m === m);
    const nearest = (list: Mark[]) =>
      list.reduce<Mark | undefined>(
        (best, mk) => (!best || Math.abs(mk.s - cur.s) < Math.abs(best.s - cur.s) ? mk : best),
        undefined,
      );
    if (e.key === later || e.key === earlier) {
      const step = e.key === later ? 1 : -1;
      for (let m = cur.m + step; m >= 0 && m < COSTS.length && !next; m += step) {
        next = nearest(inMonth(m));
      }
    } else if (e.key === 'ArrowUp') {
      next = inMonth(cur.m).find((mk) => mk.s > cur.s);
    } else if (e.key === 'ArrowDown') {
      next = [...inMonth(cur.m)].reverse().find((mk) => mk.s < cur.s);
    } else if (e.key === 'Home') {
      next = marks[0];
    } else if (e.key === 'End') {
      next = marks[marks.length - 1];
    } else return;
    e.preventDefault();
    if (next) roving.move(next.id);
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        width={width}
        height={height}
        style={svgStyle}
        role="group"
        aria-label={t.costsChart}
        data-testid="costs-svg"
      >
        <Group left={plotLeft} top={top}>
          {y.ticks(4).map((v) => (
            <line key={v} x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          ))}
          <g onKeyDown={onKey} data-testid="costs-marks">
            <BarStack<(typeof COSTS)[number], Key>
              data={COSTS}
              keys={[...KEYS]}
              x={(d) => d.month}
              xScale={x}
              yScale={y}
              color={(k) => COLOUR[k]}
            >
              {(stacks) =>
                stacks.flatMap((stack) =>
                  stack.bars.map((bar) => {
                    const s = KEYS.indexOf(stack.key);
                    const id = `${bar.index}:${s}`;
                    if (bar.height <= 0 || COSTS[bar.index][stack.key] <= 0) return null;
                    const tp = tipFor(bar.index, s);
                    const show = () =>
                      tip.showTooltip({
                        tooltipData: tp,
                        tooltipLeft: plotLeft + bar.x + bar.width / 2,
                        tooltipTop: top + bar.y,
                      });
                    return (
                      <rect
                        key={id}
                        ref={(el) => {
                          roving.refs.current.set(id, el);
                        }}
                        className="mark"
                        data-mark={`costs:${id}`}
                        role="img"
                        aria-label={`${tp.title}. ${tp.lines.join('. ')}`}
                        tabIndex={roving.active === id ? 0 : -1}
                        x={bar.x}
                        y={bar.y}
                        width={bar.width}
                        height={bar.height}
                        fill={bar.color}
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
          <AxisBottom
            top={innerH}
            scale={x}
            tickFormat={(m) => f.month(m)}
            stroke="var(--line)"
            tickStroke="var(--line)"
            tickLabelProps={{ fill: 'var(--ink-3)', fontSize: 11, textAnchor: 'middle' }}
          />
          {rtl ? (
            <AxisRight
              left={innerW}
              scale={y}
              numTicks={4}
              tickFormat={(v) => f.compact(Number(v))}
              stroke="var(--line)"
              tickStroke="var(--line)"
              tickLabelProps={
                naive
                  ? { fill: 'var(--ink-3)', fontSize: 11 }
                  : { fill: 'var(--ink-3)', fontSize: 11, textAnchor: 'start' }
              }
            />
          ) : (
            <AxisLeft
              scale={y}
              numTicks={4}
              tickFormat={(v) => f.compact(Number(v))}
              stroke="var(--line)"
              tickStroke="var(--line)"
              tickLabelProps={{ fill: 'var(--ink-3)', fontSize: 11 }}
            />
          )}
        </Group>
      </svg>
      {tip.tooltipOpen && tip.tooltipData ? (
        <TipBox tip={tip.tooltipData} left={tip.tooltipLeft ?? 0} top={tip.tooltipTop ?? 0} />
      ) : null}
    </div>
  );
}

function CostsTable({ lang }: { lang: Lang }) {
  const f = fmt(lang);
  const t = L[lang];
  return (
    <table data-testid="costs-table">
      <thead>
        <tr>
          <th>{t.month}</th>
          {KEYS.map((k) => (
            <th key={k}>{t[k]}</th>
          ))}
          <th>{t.total}</th>
        </tr>
      </thead>
      <tbody>
        {COSTS.map((r) => (
          <tr key={r.month} data-month={r.month}>
            <td>{f.monthYear(r.month)}</td>
            {KEYS.map((k) => (
              <td key={k} data-key={k}>
                {f.money(r[k])}
              </td>
            ))}
            <td data-key="total">{f.money(KEYS.reduce((a, k) => a + r[k], 0))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// The odometer: a line, and the estimate as a dashed segment.

function OdoChart({ width, lang }: { width: number; lang: Lang }) {
  const f = fmt(lang);
  const t = L[lang];
  const rtl = lang === 'ar';
  const height = 200;
  const gutter = 56;
  const top = 12;
  const bottom = 28;
  const innerW = Math.max(0, width - gutter - 16);
  const innerH = height - top - bottom;
  const date = (d: string) => new Date(`${d}T00:00:00Z`);
  const first = date(READINGS[0].date);
  const last = date(READINGS[READINGS.length - 1].date);
  const x = scaleUtc<number>({ domain: [first, last], range: rtl ? [innerW, 0] : [0, innerW] });
  const y = scaleLinear<number>({
    domain: [READINGS[0].km, READINGS[READINGS.length - 1].km],
    range: [innerH, 0],
    nice: true,
  });
  const plotLeft = rtl ? 16 : gutter;
  const actual = READINGS.filter((r) => !r.estimate);
  const lastActual = actual[actual.length - 1];
  const estimate = READINGS.filter((r) => r.estimate);
  const roving = useRoving(`p0`);
  const tip = useTooltip<Tip>();
  const monthTicks = ['2026-05-01', '2026-07-01', '2026-09-01'].map(date);

  const tipFor = (i: number): Tip => {
    const r = READINGS[i];
    return {
      title: r.estimate ? `${t.estimated} ~${f.day(r.date)}` : f.day(r.date),
      lines: [`${t.reading}: ${f.km(r.km)}`],
    };
  };
  const onKey = (e: KeyboardEvent) => {
    const i = Number(roving.active.slice(1));
    const later = rtl ? 'ArrowLeft' : 'ArrowRight';
    const earlier = rtl ? 'ArrowRight' : 'ArrowLeft';
    let n = i;
    if (e.key === later) n = Math.min(READINGS.length - 1, i + 1);
    else if (e.key === earlier) n = Math.max(0, i - 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = READINGS.length - 1;
    else return;
    e.preventDefault();
    roving.move(`p${n}`);
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height} style={svgStyle} role="group" aria-label={t.odoChart} data-testid="odo-svg">
        <Group left={plotLeft} top={top}>
          {y.ticks(4).map((v) => (
            <line key={v} x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          ))}
          <LinePath
            data={actual}
            x={(r) => x(date(r.date))}
            y={(r) => y(r.km)}
            stroke="var(--s1)"
            strokeWidth={2}
            data-testid="odo-line"
          />
          <LinePath
            data={[lastActual, ...estimate]}
            x={(r) => x(date(r.date))}
            y={(r) => y(r.km)}
            stroke="var(--s1)"
            strokeWidth={2}
            strokeDasharray="5 4"
            data-testid="odo-estimate"
          />
          <g onKeyDown={onKey}>
            {READINGS.map((r, i) => {
              const id = `p${i}`;
              const tp = tipFor(i);
              const cx = x(date(r.date));
              const cy = y(r.km);
              const show = () =>
                tip.showTooltip({ tooltipData: tp, tooltipLeft: plotLeft + cx, tooltipTop: top + cy });
              return (
                <circle
                  key={id}
                  ref={(el) => {
                    roving.refs.current.set(id, el);
                  }}
                  className="mark"
                  data-mark={`odo:${i}`}
                  role="img"
                  aria-label={`${tp.title}. ${tp.lines.join('. ')}`}
                  tabIndex={roving.active === id ? 0 : -1}
                  cx={cx}
                  cy={cy}
                  r={5}
                  fill={r.estimate ? 'var(--surface)' : 'var(--s1)'}
                  stroke="var(--s1)"
                  strokeWidth={2}
                  onFocus={() => {
                    roving.setActive(id);
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
            tickValues={monthTicks}
            tickFormat={(d) => f.month((d as Date).toISOString().slice(0, 7))}
            stroke="var(--line)"
            tickStroke="var(--line)"
            tickLabelProps={{ fill: 'var(--ink-3)', fontSize: 11, textAnchor: 'middle' }}
          />
          {rtl ? (
            <AxisRight
              left={innerW}
              scale={y}
              numTicks={4}
              tickFormat={(v) => f.num(Number(v))}
              stroke="var(--line)"
              tickStroke="var(--line)"
              tickLabelProps={
                naive
                  ? { fill: 'var(--ink-3)', fontSize: 11 }
                  : { fill: 'var(--ink-3)', fontSize: 11, textAnchor: 'start' }
              }
            />
          ) : (
            <AxisLeft
              scale={y}
              numTicks={4}
              tickFormat={(v) => f.num(Number(v))}
              stroke="var(--line)"
              tickStroke="var(--line)"
              tickLabelProps={{ fill: 'var(--ink-3)', fontSize: 11 }}
            />
          )}
        </Group>
      </svg>
      {tip.tooltipOpen && tip.tooltipData ? (
        <TipBox tip={tip.tooltipData} left={tip.tooltipLeft ?? 0} top={tip.tooltipTop ?? 0} />
      ) : null}
    </div>
  );
}

function OdoTable({ lang }: { lang: Lang }) {
  const f = fmt(lang);
  const t = L[lang];
  return (
    <table data-testid="odo-table">
      <thead>
        <tr>
          <th>{t.date}</th>
          <th>{t.reading}</th>
        </tr>
      </thead>
      <tbody>
        {READINGS.map((r) => (
          <tr key={r.date} data-date={r.date}>
            <td>{r.estimate ? `${t.estimated} ~${f.day(r.date)}` : f.day(r.date)}</td>
            <td>{f.km(r.km)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Charts({ lang }: { lang: Lang }) {
  const t = L[lang];
  return (
    <>
      <section className="card">
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>{t.costs}</h2>
        <ul aria-hidden="true" style={{ display: 'flex', gap: 14, listStyle: 'none', padding: 0, fontSize: 12.5 }}>
          {KEYS.map((k) => (
            <li key={k}>
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: COLOUR[k], marginInlineEnd: 6 }} />
              {t[k]}
            </li>
          ))}
        </ul>
        <ParentSize debounceTime={0} style={{ height: 220 }}>
          {({ width }) => (width > 0 ? <CostsChart width={width} lang={lang} /> : null)}
        </ParentSize>
        <TableToggle lang={lang} id="costs-table">
          <CostsTable lang={lang} />
        </TableToggle>
      </section>
      <section className="card">
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>{t.odo}</h2>
        <ParentSize debounceTime={0} style={{ height: 200 }}>
          {({ width }) => (width > 0 ? <OdoChart width={width} lang={lang} /> : null)}
        </ParentSize>
        <TableToggle lang={lang} id="odo-table">
          <OdoTable lang={lang} />
        </TableToggle>
      </section>
    </>
  );
}
