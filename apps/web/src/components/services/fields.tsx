/**
 * Pieces the Complete sheet and Log a service share (screens §5 Log a service, §7): a reading
 * refused at entry, said with the neighbour it collides with (D112, as the meters section says
 * it); a decimal typed in either digits; and an amount with its currency (the Purchase rule).
 */
import { AmountError, parseAmount } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { isApiError } from '@/api/client';
import type { ReadingConflictDetails } from '@/api/inventory/types';
import { westernNumber } from '@/components/things/form-model';
import { CurrencyPicker } from '@/components/things/pickers';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';

/** A reading's 409, in words with the neighbouring value, or null for any other error. */
export function useReadingRefusal() {
  const { t } = useLingui();
  const f = useFormat();
  const unitOf = useMeterUnit();
  return (e: unknown, stored: string): string | null => {
    const unit = unitOf(stored);
    if (!isApiError(e) || e.status !== 409) return null;
    const d = e.details as ReadingConflictDetails;
    if (d.reason === 'lower_than_previous' && d.previous) {
      const before = f.num(Number(d.previous.value));
      return t`Lower than the reading before it (${before} ${unit}). Check the value, or record that the meter was replaced first.`;
    }
    if (d.reason === 'higher_than_next' && d.next) {
      const after = f.num(Number(d.next.value));
      return t`Higher than the reading after it (${after} ${unit}). Check the value and the date it was taken.`;
    }
    return null;
  };
}

/** A non-negative decimal typed in Western or Eastern digits, as a canonical string; `''` for
 * nothing; `null` when it isn't a number. */
export function decimalOf(s: string): string | null {
  const w = westernNumber(s).trim();
  if (w === '') return '';
  return /^\d+(\.\d+)?$/.test(w) ? w : null;
}

/** An amount, or `''` for none, or null when it isn't one (the Purchase rule, §7). */
export function amountOf(s: string): string | null {
  if (!s.trim()) return '';
  try {
    return parseAmount(westernNumber(s));
  } catch (e) {
    if (e instanceof AmountError) return null;
    throw e;
  }
}

/** The total and its currency, side by side from `md`. */
export function MoneyFields({
  label,
  amount,
  onAmount,
  currency,
  onCurrency,
  error,
}: {
  label: string;
  amount: string;
  onAmount: (v: string) => void;
  currency: string | null;
  onCurrency: (v: string | null) => void;
  error?: string | undefined;
}) {
  const { t } = useLingui();
  return (
    <div className="grid gap-3.5 md:grid-cols-[1fr_10rem]">
      <TextField
        label={label}
        value={amount}
        onChange={onAmount}
        inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        {...(error ? { errorMessage: error, isInvalid: true } : {})}
      />
      <CurrencyPicker label={t`Currency`} value={currency} onChange={onCurrency} />
    </div>
  );
}
