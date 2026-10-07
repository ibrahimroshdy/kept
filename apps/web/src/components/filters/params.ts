/**
 * From the filter strip's URL state to a list endpoint's query (D205): each filter key maps to
 * the endpoint's parameter, several values repeat it, and `not` names the parameters that are
 * "is none of" (`?actorId=a&actorId=b&not=actorId`).
 */
import { DATE_PRESETS, type DatePreset, parseDateRange } from '@kept/shared';
import type { ListState } from '@/lib/url-state';

/** `{param: values}` for the filters `map` names (key → parameter), and `not`. */
export function filterParams<P extends string>(
  list: ListState,
  map: Record<string, P>,
): Partial<Record<P, string[]>> & { not?: P[] } {
  const out: Record<string, string[]> = {};
  const not: P[] = [];
  for (const [key, param] of Object.entries(map) as [string, P][]) {
    const values = list.filters[key];
    if (!values?.length) continue;
    out[param] = values;
    if (list.not.includes(key)) not.push(param);
  }
  return { ...(out as Partial<Record<P, string[]>>), ...(not.length ? { not } : {}) };
}

/** Local midnight of `d` plus `days`. */
function midnight(d: Date, days = 0): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() + days);
  return m;
}

/** A `YYYY-MM-DD` day's local midnight. */
function dayStart(day: string, plus = 0): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + plus);
}

/**
 * The instants a date filter value covers: `from` inclusive, `to` exclusive, local days. Presets
 * count today: "Last 7 days" is today and the six before it. Undefined bounds are open.
 */
export function dateBounds(
  value: string | undefined,
  now: Date = new Date(),
): { from?: string; to?: string } {
  if (!value) return {};
  if ((DATE_PRESETS as readonly string[]).includes(value)) {
    const preset = value as DatePreset;
    const from =
      preset === 'today'
        ? midnight(now)
        : preset === 'week'
          ? midnight(now, -6)
          : preset === 'month'
            ? midnight(now, -29)
            : new Date(now.getFullYear(), 0, 1);
    return { from: from.toISOString() };
  }
  const range = parseDateRange(value);
  if (!range) return {};
  return {
    ...(range.from ? { from: dayStart(range.from).toISOString() } : {}),
    ...(range.to ? { to: dayStart(range.to, 1).toISOString() } : {}),
  };
}
