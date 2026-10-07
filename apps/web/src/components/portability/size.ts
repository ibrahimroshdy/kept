/**
 * A file's size in the reader's language and digits, for archives and exports (step 7): "138 kB",
 * "48.2 MB", "1.2 GB". Decimal units, as the board draws them; one decimal from a megabyte up.
 */
import { formatLocale, usePrefs } from '@/lib/prefs';

const UNITS = [
  [1e9, 'gigabyte'],
  [1e6, 'megabyte'],
  [1e3, 'kilobyte'],
] as const;

export function useFileSize(): (bytes: number) => string {
  const { locale, digits } = usePrefs();
  const tag = formatLocale(locale, digits);
  return (bytes) => {
    const [size, unit] = UNITS.find(([s]) => bytes >= s) ?? [1, 'byte'];
    return new Intl.NumberFormat(tag, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: size >= 1e6 ? 1 : 0,
    }).format(bytes / size);
  };
}
