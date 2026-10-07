/**
 * Showing values: numbers, dates and amounts follow the reader's digits (D143); serials, IMEIs,
 * VINs, plates and codes are shown as printed (screens §8); user text is bidi-isolated.
 */
import { formatMoney } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useCallback } from 'react';
import type { ResolvedField } from '@/api/inventory/types';
import { useFormat } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';

export function useMoney() {
  const { locale, digits } = usePrefs();
  return useCallback(
    (amount: string, currency: string) => {
      try {
        return formatMoney(amount, currency, { locale, digits });
      } catch {
        return `${amount} ${currency}`;
      }
    },
    [locale, digits],
  );
}

/** Text as the person typed it, isolated so it keeps its own direction. */
export const Bidi = ({ children }: { children: ReactNode }) => <bdi dir="auto">{children}</bdi>;

/**
 * Codes and identifiers, shown as printed: monospace and never localised. `dir="auto"`, so a VIN
 * reads left to right and an Egyptian plate keeps its Arabic order (§8).
 */
export const Printed = ({ children }: { children: ReactNode }) => (
  <bdi dir="auto" className="font-mono text-[14px] [overflow-wrap:anywhere]">
    {children}
  </bdi>
);

/** Keys whose text is an identifier printed on the thing (shown as printed, §8). */
const PRINTED_KEYS = new Set([
  'imei',
  'imei_2',
  'vin',
  'plate',
  'mac_address',
  'firmware',
  'serial',
]);

/** A resolved field's value as it should read, or null when there is nothing to show. */
export function useFieldValue() {
  const fmt = useFormat();
  const money = useMoney();
  const { t } = useLingui();
  return useCallback(
    (field: Pick<ResolvedField, 'kind' | 'unit' | 'key'>, raw: unknown): ReactNode | null => {
      if (raw === undefined || raw === null || raw === '') return null;
      if (Array.isArray(raw)) {
        if (raw.length === 0) return null;
        const parts = raw.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: values of one field, in order
          <span key={i} className="block">
            {PRINTED_KEYS.has(field.key) ? (
              <Printed>{String(v)}</Printed>
            ) : (
              <Bidi>{String(v)}</Bidi>
            )}
          </span>
        ));
        return <>{parts}</>;
      }
      switch (field.kind) {
        case 'number': {
          const n = typeof raw === 'number' ? raw : Number(raw);
          const s = Number.isFinite(n) ? fmt.num(n) : String(raw);
          return field.unit ? `${s} ${field.unit}` : s;
        }
        case 'boolean':
          return raw === true ? t`Yes` : t`No`;
        case 'date':
          return fmt.day(String(raw));
        case 'url':
          return (
            <a
              href={String(raw)}
              target="_blank"
              rel="noreferrer noopener"
              className="text-info underline [overflow-wrap:anywhere]"
            >
              <bdi dir="ltr">{String(raw)}</bdi>
            </a>
          );
        case 'money': {
          const m = raw as { amount?: string; currency?: string };
          return m.amount && m.currency ? money(m.amount, m.currency) : null;
        }
        default:
          return PRINTED_KEYS.has(field.key) ? (
            <Printed>{String(raw)}</Printed>
          ) : (
            <Bidi>{String(raw)}</Bidi>
          );
      }
    },
    [fmt, money, t],
  );
}

/** A definition list row pair; the list itself is `<KeyValues>`. */
export function KV({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,38%)_minmax(0,1fr)] gap-3 px-3.5 py-2.5">
      <dt className="text-small text-ink-3">{label}</dt>
      <dd className="m-0 text-[15px] text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function KeyValues({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl
      aria-label={label}
      className="m-0 grid overflow-hidden rounded-[10px] border border-line bg-surface [&>div+div]:border-t [&>div+div]:border-line"
    >
      {children}
    </dl>
  );
}
