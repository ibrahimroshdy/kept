/**
 * Where a hint's beacon and popover sit, said logically and turned into driver.js's physical
 * sides (spike V18, docs/spikes/2026-09-26-step3-driver-hints.md). driver.js positions with
 * physical sides and alignments: `align: 'end'` is always the right edge, and `side: 'left'` is
 * always the left. In Arabic the start is the right, so `start ↔ end` and `left ↔ right` swap.
 * With the swap, an RTL hint is the exact mirror of the LTR one (measured in the spike).
 */

/** A side of the target, in reading terms: `start` is the left in English, the right in Arabic. */
export type LogicalSide = 'top' | 'bottom' | 'start' | 'end';
export type LogicalAlign = 'start' | 'center' | 'end';

export type PhysicalSide = 'top' | 'bottom' | 'left' | 'right';
export type PhysicalAlign = 'start' | 'center' | 'end';

/** driver.js's side for a logical one. */
export function physicalSide(side: LogicalSide, rtl: boolean): PhysicalSide {
  if (side === 'start') return rtl ? 'right' : 'left';
  if (side === 'end') return rtl ? 'left' : 'right';
  return side;
}

/** driver.js's alignment for a logical one: its `start` is the left edge in any direction. */
export function physicalAlign(align: LogicalAlign, rtl: boolean): PhysicalAlign {
  if (!rtl || align === 'center') return align;
  return align === 'start' ? 'end' : 'start';
}

/**
 * The default placement: the beacon on the target's top edge at its logical end (spike V18), and
 * the popover below the beacon, aligned to its logical end so it opens back over the target
 * rather than off the screen's edge (the spike's `start` did that, checked in the browser).
 */
export const DEFAULT_BEACON = { side: 'top', align: 'end' } as const;
export const DEFAULT_POPOVER = { side: 'bottom', align: 'end' } as const;

/** Whether the page reads right to left now (`<html dir>`, set by the locale). */
export function pageIsRtl(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
}

/** The user asked for less motion: no pulsing beacon, no animated tour. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * The text driver.js writes with `innerHTML` (title, description, button labels), escaped. Hint
 * copy is Kept's own translated constants (hint-copy.ts), never user data; escaping means even a
 * translation can't inject markup.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
