/**
 * A titled section that opens and closes (React Aria's Disclosure): the AI settings' "Why?" and
 * "Advanced" (D191: per-task models, caps and prices sit under Advanced). Controlled when the
 * page must open it itself (a key whose provider Kept can't tell opens Advanced).
 */
import type { ReactNode } from 'react';
import { Disclosure, DisclosurePanel, Heading, Button as RAButton } from 'react-aria-components';
import { ChevronDownIcon } from '@/components/icons';
import { cn } from '@/lib/utils';

export function AiDisclosure({
  title,
  children,
  isExpanded,
  onExpandedChange,
  quiet = false,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  isExpanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  /** A small inline trigger ("Why?") instead of a full-width row. */
  quiet?: boolean;
  className?: string;
}) {
  return (
    <Disclosure
      className={cn('grid gap-2', className)}
      {...(isExpanded !== undefined ? { isExpanded } : {})}
      {...(onExpandedChange ? { onExpandedChange } : {})}
    >
      <Heading className="m-0">
        <RAButton
          slot="trigger"
          className={cn(
            'group flex cursor-pointer items-center gap-2 text-start outline-none data-focus-visible:outline-2 data-focus-visible:outline-info',
            quiet
              ? 'min-h-9 font-semibold text-small text-ink underline underline-offset-2'
              : 'min-h-11 w-full justify-between rounded-[10px] border border-line bg-surface px-3.5 font-semibold text-[15px] text-ink',
          )}
        >
          {title}
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
          />
        </RAButton>
      </Heading>
      <DisclosurePanel>{children}</DisclosurePanel>
    </Disclosure>
  );
}
