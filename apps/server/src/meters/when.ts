import { addDays, parseDateRange } from '@kept/shared';

/**
 * A list's date filter (`f.when`, D205) as whole local days, `to` inclusive: `today`, the last 7
 * days (`week`), the last 30 (`month`), the year so far (`year`), or a custom range
 * `YYYY-MM-DD..YYYY-MM-DD` (either end open), as the AI calls list reads it (ai/calls.ts
 * atBounds). `today` is the location's own day. The caller has checked the value with
 * `isDateFilterValue`; anything else is no bound at all.
 */
export function whenDays(when: string, today: string): { from: string | null; to: string | null } {
  switch (when) {
    case 'today':
      return { from: today, to: null };
    case 'week':
      return { from: addDays(today, -6), to: null };
    case 'month':
      return { from: addDays(today, -29), to: null };
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: null };
    default:
      return parseDateRange(when) ?? { from: null, to: null };
  }
}
