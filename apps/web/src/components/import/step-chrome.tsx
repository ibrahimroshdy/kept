/**
 * The import stepper's frame (screens §6): the step bar with its title and "Step 2 of 6", and the
 * footer that holds Back and the step's main button (sticky above the tab bar on a phone). The
 * CSV flow has five steps (stepper.tsx), an archive six (archive-run.tsx).
 */
import type { ReactNode } from 'react';
import { StepCounter } from '@/components/auth-frame';
import { cn } from '@/lib/utils';

export function StepHeader({
  step,
  total,
  title,
}: {
  step: number;
  total: number;
  title: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <div aria-hidden="true" className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => i + 1).map((s) => (
          <span
            key={s}
            className={cn('h-1 flex-1 rounded-full', s <= step ? 'bg-ink' : 'bg-line')}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 font-semibold text-[22px] leading-tight">{title}</h2>
        <span className="eyebrow whitespace-nowrap">
          <StepCounter current={step} total={total} />
        </span>
      </div>
    </div>
  );
}

export function StepFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-10 -mx-3.5 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-3.5 pt-3 pb-9 md:static md:py-3 md:mx-0 md:rounded-[10px] md:border">
      {children}
    </div>
  );
}

/** The counts an archive holds or an import will make, as tiles (zero counts left out). */
export function CountTiles({ tiles }: { tiles: { value: string; label: ReactNode; n: number }[] }) {
  const shown = tiles.filter((x) => x.n > 0);
  if (shown.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {shown.map((tile, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of tiles
          key={i}
          className="grid content-start gap-0.5 rounded-[10px] border border-line bg-surface px-3.5 py-3"
        >
          <dd className="m-0 font-semibold text-[22px] leading-tight">{tile.value}</dd>
          <dt className="text-small text-ink-2">{tile.label}</dt>
        </div>
      ))}
    </dl>
  );
}
