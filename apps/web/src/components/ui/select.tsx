/**
 * Select: a React Aria Select, for a short fixed list where typing to filter adds nothing (the
 * interface language, a location's languages). Never a native <select> or an OS picker (the
 * maintainer's no-native-controls rule); React Aria's own hidden, aria-hidden <select> is only for
 * browser autofill and is never shown. Longer or searchable lists use the Combobox.
 *
 * Single choice by default; `selectionMode="multiple"` keeps the popover open and shows every
 * choice in the trigger. Enter/Space or ArrowDown opens it, arrows move, Escape closes. The popover
 * aligns to the trigger's inline start, so it follows the reading direction.
 *
 *   <Select label="Language" items={langs} value={locale} onChange={setLocale}
 *           renderValue={(items) => …}>{(item) => <SelectItem id={item.id} textValue={item.name}>…</SelectItem>}</Select>
 */
import type { ReactNode } from 'react';
import {
  Button as ButtonPrimitive,
  composeRenderProps,
  ListBox,
  ListBoxItem,
  type ListBoxItemProps,
  Popover,
  Select as SelectPrimitive,
  type SelectProps as SelectPrimitiveProps,
  SelectValue,
} from 'react-aria-components';
import { CheckIcon, ChevronDownIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Description, type FieldChrome, FieldError, inputClass, Label } from './field';

type Mode = 'single' | 'multiple';

export type SelectProps<T extends object, M extends Mode = 'single'> = Omit<
  SelectPrimitiveProps<T, M>,
  'children' | 'items'
> &
  FieldChrome & {
    items: Iterable<T>;
    children: (item: T) => ReactNode;
    /** What the closed trigger shows for the chosen items; defaults to their text. */
    renderValue?: (selected: T[]) => ReactNode;
    /** The trigger's classes, e.g. a compact trigger in the sign-in header. */
    triggerClassName?: string;
  };

export function Select<T extends object, M extends Mode = 'single'>({
  label,
  description,
  errorMessage,
  items,
  children,
  renderValue,
  triggerClassName,
  className,
  ...props
}: SelectProps<T, M>) {
  return (
    <SelectPrimitive<T, M>
      data-slot="select"
      className={composeRenderProps(className, (cls) => cn('grid gap-1', cls))}
      {...props}
    >
      {label ? <Label>{label}</Label> : null}
      <ButtonPrimitive
        data-slot="select-trigger"
        className={cn(
          inputClass,
          'flex cursor-pointer items-center gap-2 pe-2 text-start data-pressed:bg-sunken',
          triggerClassName,
        )}
      >
        <SelectValue<T> className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {({ selectedItems, defaultChildren, isPlaceholder }) =>
            renderValue && !isPlaceholder
              ? renderValue(selectedItems.filter((i): i is T => i != null))
              : defaultChildren
          }
        </SelectValue>
        <ChevronDownIcon aria-hidden="true" className="size-5 shrink-0 text-ink-2" />
      </ButtonPrimitive>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover
        data-slot="select-popover"
        offset={6}
        className="z-50 max-h-80 w-(--trigger-width) min-w-52 overflow-y-auto rounded-[10px] border border-line bg-surface text-ink shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
      >
        <ListBox<T> items={items} className="grid gap-px p-1 outline-none">
          {children}
        </ListBox>
      </Popover>
    </SelectPrimitive>
  );
}

/** One option: its content, then a check when chosen. Wraps; never cut off. */
export function SelectItem({
  className,
  children,
  ...props
}: Omit<ListBoxItemProps, 'children'> & { children: ReactNode }) {
  return (
    <ListBoxItem
      data-slot="select-item"
      className={composeRenderProps(className, (cls) =>
        cn(
          'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] leading-snug outline-none data-focused:bg-sunken data-disabled:cursor-not-allowed data-disabled:opacity-50',
          cls,
        ),
      )}
      {...props}
    >
      {({ isSelected }) => (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2.5 [overflow-wrap:anywhere]">
            {children}
          </span>
          <span className="grid size-5 shrink-0 place-items-center text-ok">
            {isSelected ? <CheckIcon /> : null}
          </span>
        </>
      )}
    </ListBoxItem>
  );
}
