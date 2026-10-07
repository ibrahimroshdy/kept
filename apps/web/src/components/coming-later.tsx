/**
 * A screen whose step isn't built yet. It still looks finished: what the screen will do, in
 * one sentence, and a way back to what works today.
 */
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { LinkButton } from '@/components/page';
import { cn } from '@/lib/utils';

export function ComingLater({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-3 px-4 py-12 text-center">
      <span className="grid size-16 place-items-center rounded-2xl bg-sunken text-ink-2 [&_svg]:size-8">
        {icon}
      </span>
      <SoonBadge />
      <h2 className="m-0 font-semibold text-title text-ink">{title}</h2>
      <p className="m-0 max-w-md text-ink-2">{children}</p>
      <LinkButton to="/" className="mt-2">
        <Trans>Back to Home</Trans>
      </LinkButton>
    </div>
  );
}

/** "Coming soon": the pill on an entry or a screen that isn't built yet (the sidebar, More). */
export function SoonBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[11px] font-medium leading-none text-ink-3',
        className,
      )}
    >
      <Trans>Coming soon</Trans>
    </span>
  );
}
