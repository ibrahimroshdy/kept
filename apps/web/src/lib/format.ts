/**
 * Numbers and dates in the person's language and digits (D143, screens §8). Short IDs, codes,
 * usernames and URLs are never passed through here: they stay as printed, Western and LTR.
 */
import { i18n, type Messages } from '@lingui/core';
import { useMemo } from 'react';
import { formatLocale, usePrefs } from './prefs';

/**
 * The separator between the parts of a line ("Warranties · 2", "Samsung TV · Home"). In Arabic it
 * is the Arabic comma, as the design board's own Arabic uses it ("مثقاب بوش، ١٨ فولت"): the kit's
 * "·" beside an Eastern digit reads as the zero "٠" ("· ٢" as ٢٠; UI step-4 review L1). The comma
 * binds to the part before it, so a line never starts with it. `keep`: the part before keeps the
 * separator in the other languages too (a no-break space before the dot).
 */
export function separatorFor(locale: string, { keep = false }: { keep?: boolean } = {}): string {
  if (locale.startsWith('ar')) return '، ';
  return keep ? '\u00a0· ' : ' · ';
}

/** The separator in the language being read (Lingui's active locale): for a line built in JSX or
 * a string. A translated message gets it from its catalogue (`localiseSeparators`). */
export const sep = (options?: { keep?: boolean }): string =>
  separatorFor(i18n.locale ?? 'en', options);

/**
 * The catalogue's messages with the language's separator (`separatorFor`) in place of " · ", so
 * every translated line follows it without a translator writing it (Lingui's compiled messages:
 * strings, or tokens whose plural and select choices are messages too).
 */
export function localiseSeparators(messages: Messages, locale: string): Messages {
  const to = separatorFor(locale);
  if (to === ' · ') return messages;
  const text = (s: string) => s.replace(/[ \u00a0]*·[ \u00a0]*/g, to);
  const walk = (m: unknown): unknown => {
    if (typeof m === 'string') return text(m);
    if (Array.isArray(m)) return m.map(walk);
    if (m && typeof m === 'object')
      return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, walk(v)]));
    return m;
  };
  return Object.fromEntries(Object.entries(messages).map(([id, m]) => [id, walk(m)])) as Messages;
}

export type Formatter = {
  /** The separator between a line's parts (`separatorFor`). */
  sep: string;
  num: (n: number) => string;
  /** "12 Oct" (this year) or "12 Oct 2027", with no-break spaces: a date never splits. */
  day: (iso: string) => string;
  /** "Sat 31 Oct 2026". */
  longDay: (iso: string) => string;
  /** "12 Oct, 09:12". */
  dateTime: (iso: string) => string;
  /** "Friday 26 September". */
  today: (d?: Date) => string;
  /** "3 days ago", "in 5 days", "today". */
  relative: (iso: string, now?: Date) => string;
};

const DAY = 86_400_000;

export function makeFormatter(tag: string): Formatter {
  const nf = new Intl.NumberFormat(tag);
  const sameYear = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' });
  const otherYear = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const long = new Intl.DateTimeFormat(tag, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const dt = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const weekday = new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long' });
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  return {
    sep: separatorFor(tag),
    num: (n) => nf.format(n),
    day: (iso) => {
      const d = new Date(iso);
      // "Deleted Sep / 27" wrapped at 375 (the phone pass): the line breaks around a date.
      return (d.getFullYear() === new Date().getFullYear() ? sameYear : otherYear)
        .format(d)
        .replace(/ /g, '\u00a0');
    },
    longDay: (iso) => long.format(new Date(iso)),
    dateTime: (iso) => dt.format(new Date(iso)),
    today: (d = new Date()) => weekday.format(d),
    relative: (iso, now = new Date()) => {
      const diff = new Date(iso).getTime() - now.getTime();
      const abs = Math.abs(diff);
      if (abs < 60_000) return rtf.format(0, 'second');
      if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
      if (abs < DAY) return rtf.format(Math.round(diff / 3_600_000), 'hour');
      return rtf.format(Math.round(diff / DAY), 'day');
    },
  };
}

/** "412 KB" (or "316 B") in the reader's language and digits. */
export function useBytes(): (n: number) => string {
  const { locale, digits } = usePrefs();
  return (n) =>
    n < 1024
      ? new Intl.NumberFormat(formatLocale(locale, digits), {
          style: 'unit',
          unit: 'byte',
          unitDisplay: 'short',
        }).format(n)
      : new Intl.NumberFormat(formatLocale(locale, digits), {
          style: 'unit',
          unit: 'kilobyte',
          unitDisplay: 'short',
          maximumFractionDigits: 0,
        }).format(n / 1024);
}

export function useFormat(): Formatter {
  const { locale, digits } = usePrefs();
  return useMemo(() => makeFormatter(formatLocale(locale, digits)), [locale, digits]);
}
