/**
 * TimeField: a time of day chosen from a list, every half hour, on the app's Select (React Aria),
 * never the OS time picker (the no-native-controls rule). `value` is a plain 'HH:MM' string on a
 * 24-hour clock, as the server stores a digest time or quiet hours (T25); a stored time off the
 * half hour stays in the list. The times read in the reader's language and digits (D143).
 *
 * A list rather than typed segments: it reuses the Select already in the shell, where React Aria's
 * DateField would add its own chunk to the precache (plan Phase C's budget).
 */
import { useMemo } from 'react';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { Select, SelectItem } from './select';

const STEP_MINUTES = 30;

const pad = (n: number) => String(n).padStart(2, '0');

/** Every half hour of the day, 'HH:MM', plus `extra` when it's off the grid. */
export function timeOptions(extra?: string | null): string[] {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += STEP_MINUTES)
    out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  if (extra && /^([01]\d|2[0-3]):[0-5]\d$/.test(extra) && !out.includes(extra)) {
    out.push(extra);
    out.sort();
  }
  return out;
}

export function TimeField({
  label,
  description,
  value,
  onChange,
  isDisabled,
  className,
}: {
  label: string;
  description?: string;
  value: string | null;
  onChange: (value: string) => void;
  isDisabled?: boolean;
  className?: string;
}) {
  const { locale, digits } = usePrefs();
  const items = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(formatLocale(locale, digits), {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    });
    return timeOptions(value).map((id) => {
      const [h, m] = id.split(':').map(Number) as [number, number];
      return { id, name: fmt.format(Date.UTC(1970, 0, 1, h, m)) };
    });
  }, [locale, digits, value]);
  return (
    <Select<{ id: string; name: string }>
      label={label}
      {...(description ? { description } : {})}
      items={items}
      value={value}
      onChange={(key) => {
        if (typeof key === 'string') onChange(key);
      }}
      isDisabled={!!isDisabled}
      triggerClassName="w-32 tabular-nums"
      {...(className ? { className } : {})}
    >
      {(item) => (
        <SelectItem id={item.id} textValue={item.name}>
          <span className="tabular-nums">{item.name}</span>
        </SelectItem>
      )}
    </Select>
  );
}
