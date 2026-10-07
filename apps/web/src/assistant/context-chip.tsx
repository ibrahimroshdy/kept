/**
 * The context chip (D24; screens §5 "Assistant" and §8, frames 04 · 4 and 04 · 6): the page the
 * assistant knows about, with × to remove it, so the next question goes with `context: none`.
 * In the phone sheet's header and at the top of the docked panel ("About Garage").
 */
import { useLingui } from '@lingui/react/macro';
import { BoxIcon, HomeIcon, InboxIcon, PinIcon, SearchIcon, XIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import type { PageContext } from './context';
import { removeContext } from './store';

const ICONS = {
  location: HomeIcon,
  place: PinIcon,
  thing: BoxIcon,
  search: SearchIcon,
  inbox: InboxIcon,
} as const;

export function ContextChip({ page, className }: { page: PageContext; className?: string }) {
  const { t } = useLingui();
  const Icon = ICONS[page.kind];
  return (
    <span
      className={cn(
        'inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface ps-2.5 text-[13px] text-ink [&>svg]:size-4 [&>svg]:shrink-0',
        className,
      )}
    >
      <Icon />
      <span className="sr-only">{t`Page context:`} </span>
      <bdi className="min-w-0 [overflow-wrap:anywhere]">
        {page.kind === 'search' ? t`“${page.label}”` : page.label}
      </bdi>
      <button
        type="button"
        aria-label={t`Remove page context`}
        onClick={() => removeContext(page.key)}
        className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-4"
      >
        <XIcon />
      </button>
    </span>
  );
}
