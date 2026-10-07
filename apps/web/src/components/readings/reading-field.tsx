/**
 * The reading's value and the check beside it (screens §7 "Reading", the board's "Log a reading"
 * frame; D26, D52, D112). The field takes a decimal in Western or Eastern digits (`٥٣٠٠٠`, `٫`),
 * and the line under it says, while you type, how the value sits against the meter's latest
 * reading:
 *
 * - **fits:** "Fits: 1,120 km since 51,220 km on 14 Sep, about 62 km a day."
 * - **a jump:** faster than the meter's daily limit: "That's 34,120 km in 18 days, about 1,900 km
 *   a day, over the limit of 1,500 km a day. Is it right?" The sheet then offers **It's right**,
 *   which sends `confirmJump` (Q9), and **Edit**.
 * - **lower:** "25,340 km is lower than 51,220 km on 14 Sep. Readings can't go down…" with
 *   **Meter replaced**.
 *
 * This is a hint only: the server places the reading among all its neighbours, after the meter's
 * replacement offsets (meters/check.ts `placeReading`), and has the last word. The client knows
 * only the latest reading, not a custom `maxPerDay` (the thing view doesn't carry it), so the
 * limit here is §3.4's default for the meter's kind, the server's `dailyLimit()` without a custom
 * value. A reading taken before the latest one isn't checked here at all.
 */
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { decimalOf } from '@/components/services/fields';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';
import { cn } from '@/lib/utils';

const DAY_MS = 86_400_000;

/** §3.4's daily limit for a meter's kind and unit (the server's `dailyLimit()` defaults), or
 * null where none is known (a custom meter). */
export function defaultDailyLimit(meter: { kind: string; unit: string }): number | null {
  if (meter.kind === 'hours') return 24;
  if (meter.kind === 'distance') {
    const unit = meter.unit.trim().toLowerCase();
    if (unit === 'km') return 1500;
    if (unit === 'mi') return 932;
  }
  return null;
}

export type LatestReading = { value: string; takenAt: string };

export type ReadingCheck =
  | { kind: 'none' }
  | { kind: 'fits'; delta: number; since: LatestReading; days: number; perDay: number }
  | {
      kind: 'jump';
      delta: number;
      since: LatestReading;
      days: number;
      perDay: number;
      limit: number;
    }
  | { kind: 'lower'; since: LatestReading };

/**
 * How `value` (a canonical decimal, see `decimalOf`) taken at `takenAt` sits after `latest`.
 * Any gap counts as at least a day, as the server's `tooFast` does.
 */
export function checkReading(
  value: string,
  takenAt: Date,
  latest: LatestReading | null | undefined,
  limit: number | null,
): ReadingCheck {
  if (!value || !latest) return { kind: 'none' };
  const ms = takenAt.getTime() - Date.parse(latest.takenAt);
  if (Number.isNaN(ms) || ms < 0) return { kind: 'none' };
  const delta = Number(value) - Number(latest.value);
  if (delta < 0) return { kind: 'lower', since: latest };
  const days = Math.max(ms, DAY_MS) / DAY_MS;
  const perDay = delta / days;
  if (limit !== null && delta > 0 && perDay > limit)
    return { kind: 'jump', delta, since: latest, days, perDay, limit };
  return { kind: 'fits', delta, since: latest, days, perDay };
}

/** The check in words, the board's sentences. */
export function useReadingCheckText() {
  const { t } = useLingui();
  const f = useFormat();
  const unitOf = useMeterUnit();
  return (check: ReadingCheck, stored: string, value: string): string | null => {
    const unit = unitOf(stored);
    const n = (x: number) => f.num(Math.round(x));
    switch (check.kind) {
      case 'none':
        return null;
      case 'fits': {
        const delta = n(check.delta);
        const before = n(Number(check.since.value));
        const on = f.day(check.since.takenAt);
        const perDay = n(check.perDay);
        return check.days >= 1 && Date.now() - Date.parse(check.since.takenAt) >= DAY_MS
          ? t`Fits: ${delta} ${unit} since ${before} ${unit} on ${on}, about ${perDay} ${unit} a day.`
          : t`Fits: ${delta} ${unit} since ${before} ${unit} on ${on}.`;
      }
      case 'jump': {
        const delta = n(check.delta);
        const days = plural(Math.round(check.days), { one: '# day', other: '# days' });
        const perDay = n(check.perDay);
        const limit = n(check.limit);
        return t`That's ${delta} ${unit} in ${days}, about ${perDay} ${unit} a day, over the limit of ${limit} ${unit} a day. Is it right?`;
      }
      case 'lower': {
        const typed = f.num(Number(value));
        const before = n(Number(check.since.value));
        const on = f.day(check.since.takenAt);
        return t`${typed} ${unit} is lower than ${before} ${unit} on ${on}. Readings can't go down: check the digits, or record that the meter was replaced.`;
      }
    }
  };
}

/** The tone the check line takes: green, amber or red, never by colour alone (it's words). */
export const checkTone = (check: ReadingCheck) =>
  check.kind === 'fits' ? 'ok' : check.kind === 'jump' ? 'warn' : 'danger';

export function CheckLine({
  tone,
  children,
  className,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'info';
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'm-0 rounded-[10px] border border-s-4 bg-surface px-3 py-2 text-small text-ink [overflow-wrap:anywhere]',
        tone === 'ok' && 'border-ok',
        tone === 'warn' && 'border-warn',
        tone === 'danger' && 'border-danger',
        tone === 'info' && 'border-line border-s-info',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** The value field: decimal keyboard, either digits, the meter's unit in the label. */
export function ReadingField({
  unit: stored,
  value,
  onChange,
  error,
  autoFocus,
  label,
}: {
  unit: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  autoFocus?: boolean;
  /** Defaults to "Reading (km)". */
  label?: string;
}) {
  const { t } = useLingui();
  const unit = useMeterUnit()(stored);
  return (
    <TextField
      label={label ?? t`Reading (${unit})`}
      value={value}
      onChange={onChange}
      {...(autoFocus ? { autoFocus: true } : {})}
      inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
      {...(error ? { errorMessage: error, isInvalid: true } : {})}
    />
  );
}

/** A value typed in either digits, as the API's decimal: `''` for none, null when it isn't one
 * (at most 3 decimals, numeric(14,3)). */
export function readingValueOf(s: string): string | null {
  const d = decimalOf(s);
  if (d === null || d === '') return d;
  return /^\d{1,11}(\.\d{1,3})?$/.test(d) ? d : null;
}
