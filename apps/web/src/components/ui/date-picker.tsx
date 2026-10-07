/**
 * DatePicker on React Aria: typed segments plus a calendar popover. Never the OS picker (the
 * no-native-controls rule). `value` is a plain 'YYYY-MM-DD' string; min and max clamp it, e.g. a
 * membership that can't outlast the inviter's own (D180).
 */
import { type CalendarDate, parseDate } from '@internationalized/date';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import {
  Button as ButtonPrimitive,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker as DatePickerPrimitive,
  DateSegment,
  Dialog,
  Group,
  Heading,
  I18nProvider,
  Popover,
} from 'react-aria-components';
import { CalendarIcon, ChevronEndIcon, ChevronStartIcon } from '@/components/icons';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { Description, FieldError, Label } from './field';

const toDate = (v: string | null | undefined): CalendarDate | null => {
  if (!v) return null;
  try {
    return parseDate(v.slice(0, 10));
  } catch {
    return null;
  }
};

export function DatePicker({
  label,
  description,
  errorMessage,
  value,
  onChange,
  minValue,
  maxValue,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  minValue?: string;
  maxValue?: string | null;
  className?: string;
}) {
  const { t } = useLingui();
  const min = toDate(minValue);
  const max = toDate(maxValue);
  // The segments and calendar format their own digits: follow the person's digit setting (D143),
  // not the frame's plain "ar", which wrote "3/10/2026" in Western digits inside Arabic.
  const { locale, digits } = usePrefs();
  return (
    <I18nProvider locale={formatLocale(locale, digits)}>
      <DatePickerPrimitive
        data-slot="date-picker"
        value={toDate(value)}
        onChange={(d) => onChange(d ? d.toString() : null)}
        {...(min ? { minValue: min } : {})}
        {...(max ? { maxValue: max } : {})}
        isInvalid={!!errorMessage}
        className={cn('grid gap-1', className)}
      >
        <Label>{label}</Label>
        <Group className="flex min-h-11 items-center rounded-lg border border-line bg-surface ps-3 data-focus-within:border-info data-invalid:border-danger">
          <DateInput className="flex flex-1 flex-wrap py-2 text-[16px] leading-[1.3] text-ink">
            {(segment) => (
              <DateSegment
                segment={segment}
                className="rounded px-0.5 tabular-nums outline-none data-focused:bg-info data-focused:text-surface data-placeholder:text-ink-3"
              />
            )}
          </DateInput>
          <ButtonPrimitive
            aria-label={t`Choose a date`}
            className="grid size-11 cursor-pointer place-items-center rounded-e-lg text-ink-2 outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:text-ink"
          >
            <CalendarIcon />
          </ButtonPrimitive>
        </Group>
        {description ? <Description>{description}</Description> : null}
        <FieldError>{errorMessage}</FieldError>
        <Popover
          offset={6}
          className="z-50 rounded-[10px] border border-line bg-surface p-3 text-ink shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
        >
          <Dialog className="outline-none">
            <Calendar className="grid gap-2">
              <header className="flex items-center justify-between gap-2">
                <ButtonPrimitive
                  slot="previous"
                  aria-label={t`Previous month`}
                  className="grid size-10 cursor-pointer place-items-center rounded-lg outline-none data-hovered:bg-sunken data-focus-visible:outline-2 data-focus-visible:outline-info"
                >
                  <ChevronStartIcon />
                </ButtonPrimitive>
                <Heading className="m-0 font-semibold text-[15px]" />
                <ButtonPrimitive
                  slot="next"
                  aria-label={t`Next month`}
                  className="grid size-10 cursor-pointer place-items-center rounded-lg outline-none data-hovered:bg-sunken data-focus-visible:outline-2 data-focus-visible:outline-info"
                >
                  <ChevronEndIcon />
                </ButtonPrimitive>
              </header>
              <CalendarGrid className="border-separate border-spacing-0.5">
                {(date) => (
                  <CalendarCell
                    date={date}
                    className="grid size-10 cursor-pointer place-items-center rounded-lg text-[14px] tabular-nums outline-none data-hovered:bg-sunken data-selected:bg-ink data-selected:text-paper data-disabled:cursor-not-allowed data-disabled:text-ink-3 data-disabled:opacity-40 data-outside-month:hidden data-focus-visible:outline-2 data-focus-visible:outline-info"
                  />
                )}
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </DatePickerPrimitive>
    </I18nProvider>
  );
}
