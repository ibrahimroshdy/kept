/**
 * Segmented control and choice cards: both are a React Aria RadioGroup, so arrow keys move the
 * choice (mirrored in RTL) and a screen reader hears "radio, 2 of 3". Never a native <select>.
 *
 *   <Segmented label="Role" value={role} onChange={setRole}
 *              options={[{ id: 'member', label: 'Member' }, ...]} />
 */
import type { ReactNode } from 'react';
import { Radio, RadioGroup, type RadioGroupProps } from 'react-aria-components';
import { cn } from '@/lib/utils';
import { Description, Label } from './field';

export type SegmentedOption<K extends string> = {
  id: K;
  label: ReactNode;
  isDisabled?: boolean;
};

type Common<K extends string> = Omit<RadioGroupProps, 'value' | 'onChange' | 'children'> & {
  label?: ReactNode;
  description?: ReactNode;
  value: K;
  onChange: (value: K) => void;
};

export function Segmented<K extends string>({
  label,
  description,
  options,
  value,
  onChange,
  className,
  ...props
}: Common<K> & { options: readonly SegmentedOption<K>[] }) {
  return (
    <RadioGroup
      data-slot="segmented"
      value={value}
      onChange={(v) => onChange(v as K)}
      orientation="horizontal"
      className={cn('grid gap-1.5', className as string)}
      {...props}
    >
      {label ? <Label>{label}</Label> : null}
      {/*
        One row of equal segments, the line between them the grid's 1 px gap over bg-line. Four or
        more worded options take two columns on a phone rather than squeezing each label onto two
        lines inside its segment (the phone pass: AI usage's Period wrapped "Last 3 months" at 375).
      */}
      <div
        className={cn(
          'grid auto-cols-fr grid-flow-col gap-px overflow-hidden rounded-lg border border-line bg-line',
          twoColumnsOnPhone(options) &&
            'max-sm:grid-flow-row max-sm:grid-cols-2 max-sm:[&>:last-child:nth-child(odd)]:col-span-2',
        )}
      >
        {options.map((o) => (
          <Radio
            key={o.id}
            value={o.id}
            isDisabled={o.isDisabled ?? false}
            className="flex min-h-11 min-w-0 cursor-pointer items-center justify-center bg-surface px-2 py-2 text-center text-[14px] leading-tight text-ink outline-none [text-wrap:balance] data-selected:bg-ink data-selected:text-paper data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-disabled:cursor-not-allowed data-disabled:opacity-50"
          >
            {o.label}
          </Radio>
        ))}
      </div>
      {description ? <Description>{description}</Description> : null}
    </RadioGroup>
  );
}

/** Four or more options whose labels, together, are too long for one row at 375 px. */
function twoColumnsOnPhone(options: readonly SegmentedOption<string>[]): boolean {
  if (options.length < 4) return false;
  const words = options.map((o) => (typeof o.label === 'string' ? o.label.length : 12));
  return words.reduce((a, b) => a + b, 0) > 28;
}

export type ChoiceCardOption<K extends string> = {
  id: K;
  title: ReactNode;
  body?: ReactNode;
  extra?: ReactNode;
};

/** Big radio cards (What to track's presets, D191): the whole card is the target. */
export function ChoiceCards<K extends string>({
  label,
  options,
  value,
  onChange,
  className,
  ...props
}: Common<K> & { options: readonly ChoiceCardOption<K>[] }) {
  return (
    <RadioGroup
      data-slot="choice-cards"
      value={value}
      onChange={(v) => onChange(v as K)}
      className={cn('grid gap-2.5', className as string)}
      {...props}
    >
      {label ? <Label>{label}</Label> : null}
      {options.map((o) => (
        <Radio
          key={o.id}
          value={o.id}
          className="group flex cursor-pointer items-start gap-3 rounded-[10px] border border-line bg-surface p-3.5 text-ink outline-none data-selected:border-2 data-selected:border-ink data-selected:p-[13px] data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-info"
        >
          <span
            aria-hidden="true"
            className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-ink-3 group-data-selected:border-ink"
          >
            <span className="hidden size-2.5 rounded-full bg-ink group-data-selected:block" />
          </span>
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="font-semibold text-[16px] leading-snug">{o.title}</span>
            {o.body ? <span className="text-small text-ink-2">{o.body}</span> : null}
            {o.extra}
          </span>
        </Radio>
      ))}
    </RadioGroup>
  );
}
