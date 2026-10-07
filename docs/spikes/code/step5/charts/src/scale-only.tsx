// SPIKE (step 5, T0, V38). The fail path, built only for its chunk size: the same two charts drawn
// by hand in SVG with @visx/scale alone (no axis, shape, group, tooltip or responsive packages).
// Not exercised by check.mjs beyond rendering.
import { scaleBand, scaleLinear, scaleUtc } from '@visx/scale';
import { COSTS, fmt, KEYS, L, type Lang, READINGS } from './data';

const COLOUR = { fuel: 'var(--s1)', service: 'var(--s2)', fees: 'var(--s3)' } as const;

export default function ScaleOnly({ lang }: { lang: Lang }) {
  const f = fmt(lang);
  const t = L[lang];
  const rtl = lang === 'ar';
  const W = 343;
  const H = 220;
  const innerW = W - 60;
  const innerH = H - 40;
  const x = scaleBand<string>({ domain: COSTS.map((r) => r.month), range: rtl ? [innerW, 0] : [0, innerW], padding: 0.3 });
  const max = Math.max(...COSTS.map((r) => KEYS.reduce((a, k) => a + r[k], 0)));
  const y = scaleLinear<number>({ domain: [0, max], range: [innerH, 0], nice: true });
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const ox = scaleUtc<number>({ domain: [d(READINGS[0].date), d(READINGS[6].date)], range: rtl ? [innerW, 0] : [0, innerW] });
  const oy = scaleLinear<number>({ domain: [READINGS[0].km, READINGS[6].km], range: [innerH, 0], nice: true });
  const pts = READINGS.map((r) => `${ox(d(r.date))},${oy(r.km)}`);
  return (
    <section className="card">
      <svg width={W} height={H} style={{ direction: 'ltr' }} role="group" aria-label={t.costsChart}>
        <g transform={`translate(${rtl ? 8 : 52},12)`}>
          {y.ticks(4).map((v) => (
            <g key={v}>
              <line x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--line)" />
              <text x={rtl ? innerW + 6 : -6} y={y(v) + 4} textAnchor={rtl ? 'start' : 'end'} fontSize={11}>
                {f.compact(v)}
              </text>
            </g>
          ))}
          {COSTS.map((r) => {
            let acc = 0;
            return KEYS.map((k) => {
              const y0 = y(acc);
              acc += r[k];
              return r[k] > 0 ? (
                <rect key={r.month + k} tabIndex={-1} role="img" aria-label={`${f.monthYear(r.month)}: ${f.money(r[k])}`}
                  x={x(r.month)} y={y(acc)} width={x.bandwidth()} height={y0 - y(acc)} fill={COLOUR[k]} />
              ) : null;
            });
          })}
          {COSTS.map((r) => (
            <text key={r.month} x={(x(r.month) ?? 0) + x.bandwidth() / 2} y={innerH + 16} textAnchor="middle" fontSize={11}>
              {f.month(r.month)}
            </text>
          ))}
        </g>
      </svg>
      <svg width={W} height={H} style={{ direction: 'ltr' }} role="group" aria-label={t.odoChart}>
        <g transform={`translate(${rtl ? 8 : 52},12)`}>
          <polyline points={pts.slice(0, 6).join(' ')} fill="none" stroke="var(--s1)" strokeWidth={2} />
          <polyline points={pts.slice(5).join(' ')} fill="none" stroke="var(--s1)" strokeWidth={2} strokeDasharray="5 4" />
        </g>
      </svg>
    </section>
  );
}
