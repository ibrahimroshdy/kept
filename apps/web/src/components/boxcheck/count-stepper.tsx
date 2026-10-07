/**
 * "Found 2 of 3" (D40, screens §6; board frame 3): how many of a quantity row are in the box. A
 * React Aria NumberField, so arrow keys, Page Up/Down and typing work, and the value is announced;
 * the − and + buttons are 44 px targets.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Button, Group, I18nProvider, Input, NumberField } from 'react-aria-components';
import { useFormat } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';

const step =
  'grid size-11 cursor-pointer place-items-center rounded-[10px] text-[20px] text-ink outline-none data-disabled:cursor-default data-disabled:text-ink-3 data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:bg-sunken';

export function CountStepper({
  value,
  max,
  onChange,
  name,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  /** The thing's name, for the field's accessible label. */
  name: string;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const total = fmt.num(max);
  // The field formats its own digits: follow the person's digit setting like the rest (D143).
  const { locale, digits } = usePrefs();
  return (
    <I18nProvider locale={formatLocale(locale, digits)}>
      <NumberField
        value={value}
        minValue={0}
        maxValue={max}
        step={1}
        onChange={(n) => onChange(Number.isFinite(n) ? Math.round(n) : 0)}
        aria-label={t`${name}: how many you found, out of ${total}`}
        className="flex flex-wrap items-center gap-2"
      >
        <span aria-hidden="true" className="text-small text-ink-3">
          <Trans>Found</Trans>
        </span>
        <Group className="inline-flex items-center rounded-[10px] border border-line bg-surface">
          <Button slot="decrement" aria-label={t`One fewer`} className={step}>
            −
          </Button>
          <Input className="w-10 bg-transparent text-center font-semibold text-ink outline-none" />
          <Button slot="increment" aria-label={t`One more`} className={step}>
            +
          </Button>
        </Group>
        <span aria-hidden="true" className="text-small text-ink-3">
          {t`of ${total}`}
        </span>
      </NumberField>
    </I18nProvider>
  );
}
