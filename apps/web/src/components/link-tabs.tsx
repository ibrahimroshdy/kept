/**
 * Tabs that are links (settings sections): each is its own URL, so every state can be linked
 * (screens §2). Styled like the Tabs primitive. On a narrow phone the tabs keep one row that
 * scrolls sideways, with the current tab brought into view; a label is never cut with … or
 * wrapped (UI audit L1: Settings, Admin, Account and AI usage's tabs wrapped onto a second row at
 * 375 px, with the underline on either row).
 */
import { useLingui } from '@lingui/react/macro';
import { Link, type LinkProps, useLocation } from '@tanstack/react-router';
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { useSectionTabs } from '@/components/page';

export type LinkTab = {
  key: string;
  label: ReactNode;
  link: LinkProps;
  /** Marks the tab current on a sub-page it doesn't prefix (Members → Invite). */
  current?: boolean;
};

/**
 * The strip: one row, scrolled sideways when the tabs don't fit, with no scroll bar drawn. The
 * baseline is an inset shadow rather than a border the tabs overlap with `-mb-px`: a scrolling
 * box clips whatever hangs below it.
 */
export const tabStripClass =
  'flex gap-x-1 overflow-x-auto overscroll-x-contain shadow-[inset_0_-1px_0_var(--line)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

/** One tab in a strip: it never wraps and never shrinks, so its label stays whole. */
export const stripTabClass =
  'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 font-semibold text-[14px] leading-tight text-ink-3 outline-none';

/**
 * Scrolls a strip sideways so its current tab (aria-current, React Aria's data-selected, or the
 * router's data-status=active) is in view, without moving the page. Runs when `key` changes.
 */
export function useCurrentTabInView(ref: RefObject<HTMLElement | null>, key: unknown) {
  useLayoutEffect(() => {
    void key;
    const strip = ref.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const tab = strip.querySelector<HTMLElement>(
      '[aria-current=page], [data-selected], [data-status=active]',
    );
    if (!tab) return;
    const s = strip.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    const pad = 24;
    if (r.right > s.right) strip.scrollLeft += r.right - s.right + pad;
    else if (r.left < s.left) strip.scrollLeft -= s.left - r.left + pad;
  }, [ref, key]);
}

export function LinkTabs({ tabs, label }: { tabs: LinkTab[]; label?: string }) {
  const { t } = useLingui();
  const strip = useRef<HTMLDivElement>(null);
  const href = useLocation({ select: (l) => l.href });
  useCurrentTabInView(strip, href);
  // Every tab of the section shares one width under Full width (components/page.tsx).
  useSectionTabs();
  return (
    // min-w-0: a grid item sizes to its content's min-content, and a whole row of tabs would
    // widen the page past the phone's edge; only the strip inside scrolls.
    <nav aria-label={label ?? t`Sections`} className="min-w-0">
      <div ref={strip} className={tabStripClass}>
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            {...tab.link}
            {...(tab.current ? { 'aria-current': 'page' as const } : {})}
            className={`${stripTabClass} hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info aria-[current=page]:border-amber aria-[current=page]:text-ink data-[status=active]:border-amber data-[status=active]:text-ink`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
