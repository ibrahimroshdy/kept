/**
 * The app's own PIN keypad (step-8 plan T23; board frame 111): dots for the digits typed, then
 * 1–9, an extra key (Face ID, or nothing), 0 and Delete. Never the system keyboard on a phone; a
 * hardware keyboard's digits and Backspace work too. The keypad keeps its order in Arabic, as a
 * phone's does; its digits follow the reader's digit setting.
 */
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect } from 'react';
import { Button } from 'react-aria-components';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';

const KEY =
  'grid min-h-14 place-items-center rounded-full text-[24px] text-ink outline-none transition-colors pressed:bg-sunken focus-visible:outline-2 focus-visible:outline-info disabled:opacity-40';

export function PinPad({
  value,
  onChange,
  length,
  max,
  disabled = false,
  extra,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Dots to draw: the PIN's length when known, else as many as typed (at least six). */
  length?: number;
  max: number;
  disabled?: boolean;
  /** The key left of 0 (the passkey), or nothing. */
  extra?: ReactNode;
  /** What the dots mean, for a screen reader. */
  label: string;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const press = (d: string) => {
    if (!disabled && value.length < max) onChange(value + d);
  };
  const back = () => {
    if (!disabled) onChange(value.slice(0, -1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (!disabled && value.length < max) onChange(value + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (!disabled) onChange(value.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [value, max, disabled, onChange]);

  const dots = Math.max(length ?? 6, value.length);
  return (
    <div className="grid w-full max-w-[18rem] justify-items-center gap-6">
      <div
        role="img"
        aria-label={`${label}: ${t`${value.length} of ${dots} digits`}`}
        className="flex gap-3"
        dir="ltr"
      >
        {Array.from({ length: dots }, (_, i) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: dots have no identity
            key={i}
            className={cn(
              'block size-3 rounded-full border border-ink',
              i < value.length && 'bg-ink',
            )}
          />
        ))}
      </div>
      <div className="grid w-full grid-cols-3 gap-3" dir="ltr">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Button key={d} className={KEY} isDisabled={disabled} onPress={() => press(d)}>
            {f.num(Number(d))}
          </Button>
        ))}
        <div className="grid place-items-center">{extra}</div>
        <Button className={KEY} isDisabled={disabled} onPress={() => press('0')}>
          {f.num(0)}
        </Button>
        <Button
          className={cn(KEY, 'text-[15px] text-ink-2')}
          isDisabled={disabled || value.length === 0}
          onPress={back}
        >
          {t`Delete`}
        </Button>
      </div>
    </div>
  );
}
