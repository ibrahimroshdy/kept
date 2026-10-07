/**
 * Combobox: the only picker Kept uses. Never a native <select> or an OS picker (the maintainer's
 * no-native-controls rule): those can't be searched, styled, or translated consistently.
 *
 * Type to filter, ArrowDown/ArrowUp to move, Enter to choose, Escape to close. The popover
 * aligns to the field's inline start, so it follows the reading direction.
 *
 *   <Combobox label="Currency" items={[{ id: 'EGP', label: 'Egyptian pound' }]}
 *             selectedKey={code} onSelectionChange={setCode} />
 */
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import {
  Button as ButtonPrimitive,
  ComboBox as ComboBoxPrimitive,
  type ComboBoxProps as ComboBoxPrimitiveProps,
  composeRenderProps,
  Group,
  Input,
  type Key,
  ListBox,
  ListBoxItem,
  type ListBoxItemProps,
  Popover,
} from 'react-aria-components';
import { CheckIcon, ChevronDownIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Description, type FieldChrome, FieldError, inputClass, Label } from './field';

export type ComboboxOption = {
  id: Key;
  label: string;
  /** A second line, e.g. "Cairo · 12 things". Wraps; never cut off. */
  description?: string;
};

export type ComboboxProps<T extends ComboboxOption> = Omit<
  ComboBoxPrimitiveProps<T>,
  'children' | 'items' | 'defaultItems'
> &
  FieldChrome & {
    items: Iterable<T>;
    placeholder?: string;
    /** Shown when nothing matches what was typed. */
    emptyText?: ReactNode;
    children?: (item: T) => ReactNode;
  };

export function Combobox<T extends ComboboxOption>({
  label,
  description,
  errorMessage,
  items,
  placeholder,
  emptyText,
  children,
  className,
  ...props
}: ComboboxProps<T>) {
  const { t } = useLingui();
  return (
    <ComboBoxPrimitive
      data-slot="combobox"
      defaultItems={items}
      // Keep the popover open with a "No matches" line rather than silently closing.
      allowsEmptyCollection
      className={composeRenderProps(className, (cls) => cn('grid gap-1', cls))}
      {...props}
    >
      {label ? <Label>{label}</Label> : null}
      <Group className="relative flex">
        <Input className={cn(inputClass, 'pe-11')} placeholder={placeholder} />
        <ButtonPrimitive
          data-slot="combobox-trigger"
          className="absolute inset-y-0 end-0 grid w-11 cursor-pointer place-items-center rounded-e-lg text-ink-2 outline-none data-hovered:text-ink"
        >
          <ChevronDownIcon />
        </ButtonPrimitive>
      </Group>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover
        data-slot="combobox-popover"
        offset={6}
        className="z-50 max-h-72 w-(--trigger-width) min-w-48 overflow-y-auto rounded-[10px] border border-line bg-surface text-ink shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
      >
        <ListBox<T>
          className="grid gap-px p-1 outline-none"
          renderEmptyState={() => (
            <div className="px-3 py-2.5 text-small text-ink-3">{emptyText ?? t`No matches`}</div>
          )}
        >
          {children ?? ((item: T) => <ComboboxItem item={item} />)}
        </ListBox>
      </Popover>
    </ComboBoxPrimitive>
  );
}

export function ComboboxItem<T extends ComboboxOption>({
  item,
  className,
  ...props
}: Omit<ListBoxItemProps<T>, 'id' | 'textValue' | 'children'> & { item: T }) {
  return (
    <ListBoxItem
      id={item.id}
      textValue={item.label}
      data-slot="combobox-item"
      className={composeRenderProps(className, (cls) =>
        cn(
          'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[15px] leading-snug outline-none data-focused:bg-sunken data-disabled:cursor-not-allowed data-disabled:opacity-50',
          cls,
        ),
      )}
      {...props}
    >
      {({ isSelected }) => (
        <>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="[overflow-wrap:anywhere]">{item.label}</span>
            {item.description ? (
              <span className="text-small text-ink-3 [overflow-wrap:anywhere]">
                {item.description}
              </span>
            ) : null}
          </span>
          <span className="grid size-5 shrink-0 place-items-center text-ok">
            {isSelected ? <CheckIcon /> : null}
          </span>
        </>
      )}
    </ListBoxItem>
  );
}
