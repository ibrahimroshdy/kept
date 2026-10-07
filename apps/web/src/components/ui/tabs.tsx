/**
 * Tabs (shadcn aria base, restyled). Arrow keys move between tabs and follow the reading
 * direction: in Arabic, ArrowLeft goes to the next tab. React Aria handles that from the locale.
 * The list keeps one row and scrolls sideways when the tabs don't fit (UI audit L1), as LinkTabs
 * does; the focused tab scrolls into view as the arrow keys move.
 */
import {
  composeRenderProps,
  TabList as TabListPrimitive,
  type TabListProps,
  TabPanel as TabPanelPrimitive,
  type TabPanelProps,
  Tab as TabPrimitive,
  type TabProps,
  Tabs as TabsPrimitive,
  type TabsProps,
} from 'react-aria-components';
import { cn } from '@/lib/utils';

export function Tabs({ className, ...props }: TabsProps) {
  return (
    <TabsPrimitive
      data-slot="tabs"
      className={composeRenderProps(className, (cls) => cn('grid content-start gap-3', cls))}
      {...props}
    />
  );
}

export function TabList<T extends object>({ className, ...props }: TabListProps<T>) {
  return (
    <TabListPrimitive
      data-slot="tab-list"
      className={composeRenderProps(className, (cls) =>
        cn(
          'flex gap-1 overflow-x-auto overscroll-x-contain shadow-[inset_0_-1px_0_var(--line)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          cls,
        ),
      )}
      {...props}
    />
  );
}

export function Tab({ className, ...props }: TabProps) {
  return (
    <TabPrimitive
      data-slot="tab"
      className={composeRenderProps(className, (cls) =>
        cn(
          'inline-flex min-h-11 shrink-0 cursor-pointer items-center whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 font-semibold text-[14px] leading-tight text-ink-3 outline-none data-hovered:text-ink data-selected:border-amber data-selected:text-ink data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-disabled:cursor-not-allowed data-disabled:opacity-50',
          cls,
        ),
      )}
      {...props}
    />
  );
}

export function TabPanel({ className, ...props }: TabPanelProps) {
  return (
    <TabPanelPrimitive
      data-slot="tab-panel"
      className={composeRenderProps(className, (cls) =>
        cn('outline-none data-focus-visible:outline-2 data-focus-visible:outline-info', cls),
      )}
      {...props}
    />
  );
}
