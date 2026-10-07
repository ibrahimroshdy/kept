/**
 * "As of last sync, 14:02" (D188): offline answers say how old they are. Today it is the time
 * alone; an older snapshot adds the day, so a week-old copy never passes for this morning's.
 */
export function asOfTime(iso: string, localeTag: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(localeTag, {
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}
