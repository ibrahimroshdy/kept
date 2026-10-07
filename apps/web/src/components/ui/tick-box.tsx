/**
 * A tick box drawn as the kit's, around React Aria's Checkbox (the same drawing as the incident
 * sheet's, which predates this file): a 44 px row, the box at the inline start, the label beside
 * it, and a description under the label. Never a native checkbox's own look.
 */
import type { ReactNode } from 'react';
import { Checkbox } from 'react-aria-components';
import { CheckIcon } from '@/components/icons';
import { cn } from '@/lib/utils';

export function TickBox({
  isSelected,
  onChange,
  isDisabled,
  children,
  description,
  className,
}: {
  isSelected: boolean;
  onChange: (v: boolean) => void;
  isDisabled?: boolean;
  children: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <Checkbox
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled ?? false}
      className={cn(
        'group flex min-h-11 cursor-pointer items-start gap-3 py-2 outline-none data-disabled:cursor-not-allowed data-disabled:opacity-60 data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-info',
        className,
      )}
    >
      {({ isSelected: on }) => (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] border-2 [&_svg]:size-3.5',
              on ? 'border-ink bg-ink text-paper' : 'border-ink-3 bg-surface',
            )}
          >
            {on ? <CheckIcon strokeWidth="3" /> : null}
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="[overflow-wrap:anywhere]">{children}</span>
            {description ? (
              <span className="text-small text-ink-2 [overflow-wrap:anywhere]">{description}</span>
            ) : null}
          </span>
        </>
      )}
    </Checkbox>
  );
}
