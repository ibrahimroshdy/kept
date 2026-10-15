/**
 * The visual viewport (#130): the part of the page a person can see. On a phone it ends at the
 * top of the on-screen keyboard and the browser's form bar (iOS's ▲ ▼ ✓) while the layout
 * viewport, which `fixed` positions follow, still runs under them; a bottom sheet sized to the
 * window puts its last rows behind the keyboard. A sheet that reads this box stays above it.
 */
import { useEffect, useState } from 'react';

export type VisibleBox = { top: number; height: number };

/** The visible box now, or null: no visualViewport, or the page is pinch-zoomed (the box is then
 * a small window into the page, not the space a sheet has). */
export function visibleBox(): VisibleBox | null {
  const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
  if (!vv || vv.scale > 1.01) return null;
  return { top: Math.round(vv.offsetTop), height: Math.round(vv.height) };
}

/** The visible box, kept current while `enabled` (resizes and scrolls of the visual viewport). */
export function useVisibleBox(enabled = true): VisibleBox | null {
  const [box, setBox] = useState<VisibleBox | null>(() => (enabled ? visibleBox() : null));
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setBox(null);
      return;
    }
    const update = () =>
      setBox((prev) => {
        const next = visibleBox();
        return prev && next && prev.top === next.top && prev.height === next.height ? prev : next;
      });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);
  return box;
}
