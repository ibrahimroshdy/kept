/**
 * A Home section (D240): a heading in the page's own type, not the eyebrow other pages use, with
 * an optional action at its end ("All activity", "+ New location", "Open"), as the approved Home
 * design draws them.
 */
import { Link, type LinkProps } from '@tanstack/react-router';
import { type ReactNode, useId } from 'react';
import { cn } from '@/lib/utils';

export function HomeSection({
  title,
  action,
  children,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('grid min-w-0 content-start gap-1', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h2 id={id} className="m-0 py-1.5 font-semibold text-[15px] leading-[1.35] text-ink">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A section's action as a link: 44 px tall to tap, 13 px to read. */
export function SectionLink({
  children,
  ...link
}: Pick<LinkProps, 'to' | 'params' | 'search'> & { children: ReactNode }) {
  return (
    <Link
      {...(link as LinkProps)}
      className="inline-flex min-h-11 items-center gap-1 font-semibold text-[13px] text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-4"
    >
      {children}
    </Link>
  );
}
