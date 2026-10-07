/**
 * What the vehicle charts share (plan T18; D133, V38): the reading direction, one tab stop per
 * chart with the arrow keys moving between its marks (a roving `tabIndex`), and the tooltip.
 *
 * Rules from the step-5 chart spike (docs/spikes/2026-09-30-step5-charts.md):
 * - a chart's `<svg>` is `direction: ltr`, and RTL is drawn by geometry (the time scale's range
 *   reversed, the value axis on the right): inherited `rtl` flips SVG `text-anchor`;
 * - the arrow keys move the way they point on screen, so in Arabic ← is later in time;
 * - the tooltip opens on focus as well as hover and is `aria-hidden`: each mark's `aria-label`
 *   says the same words, and "Show as table" gives the same numbers;
 * - visx animates nothing; the tooltip has no transition, so reduced motion needs nothing more.
 */
import { TooltipWithBounds } from '@visx/tooltip';
import { useEffect, useRef, useState } from 'react';
import { directionOf, usePrefs } from '@/lib/prefs';

/** A chart's width where ResizeObserver is missing (old browsers, tests). */
export const FALLBACK_WIDTH = 640;

export const SVG_STYLE = { display: 'block', direction: 'ltr' } as const;

export function useRtl(): boolean {
  const { locale } = usePrefs();
  return directionOf(locale) === 'rtl';
}

export type Tip = { title: string; lines: string[] };

export function TipBox({ tip, x, y }: { tip: Tip; x: number; y: number }) {
  return (
    <TooltipWithBounds
      left={x}
      top={y}
      unstyled
      applyPositionStyle
      className="pointer-events-none z-10 grid max-w-60 gap-0.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-small text-ink-2 shadow-md"
      aria-hidden="true"
      data-chart-tip=""
    >
      <strong className="text-ink">{tip.title}</strong>
      {tip.lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </TooltipWithBounds>
  );
}

/** Focus follows the active mark once it changes by keyboard (not on hover). */
export function useRoving(initial: string) {
  const [active, setActive] = useState(initial);
  const refs = useRef(new Map<string, SVGElement | null>());
  const byKey = useRef(false);
  useEffect(() => {
    if (!byKey.current) return;
    byKey.current = false;
    (refs.current.get(active) as unknown as HTMLElement | undefined)?.focus();
  }, [active]);
  const move = (k: string) => {
    byKey.current = true;
    setActive(k);
  };
  return { active, setActive, move, refs };
}

/** The keys "later" and "earlier" are on screen, for a time axis in this direction. */
export const timeKeys = (rtl: boolean) => ({
  later: rtl ? 'ArrowLeft' : 'ArrowRight',
  earlier: rtl ? 'ArrowRight' : 'ArrowLeft',
});
