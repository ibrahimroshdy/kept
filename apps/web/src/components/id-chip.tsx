/**
 * The short-ID chip (D120, D134): the one visual motif, Plex Mono on amber label tape, the same
 * object as the printed label on the box. The code is shown as printed, split 3 + 3 with a
 * non-breaking hyphen (7KQ‑4MZ), always left to right, even inside Arabic (screens §8); its
 * accessible name is the whole code.
 *
 * When the server allocates the code while the chip is on screen (null → code), or the parent
 * says the code is `fresh` (a thing just created), the chip runs out like printed tape once
 * (D195). Only under `prefers-reduced-motion: no-preference`.
 *
 * `pending` (D112): a thing captured offline has no code until it syncs. With `code` null and
 * `pending`, the chip is a dashed outline reading "ID pending", announced as "ID pending"; when
 * the code arrives it prints like any new code.
 */
import { printedCode } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// "7KQ4MZ" → "7KQ‑4MZ": the shared helper, so the chip and the printed inventory never drift.
export { printedCode };

function motionAllowed(): boolean {
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function IdChip({
  code,
  fresh = false,
  size = 'default',
  pending = false,
  className,
}: {
  code: string | null;
  /** No code yet because the thing hasn't synced (D112): show "ID pending" instead of nothing. */
  pending?: boolean;
  /** The code was just allocated (e.g. the create response): print it on mount. */
  fresh?: boolean;
  size?: 'default' | 'large';
  className?: string;
}) {
  const hadCode = useRef(code !== null);
  const [printing, setPrinting] = useState(() => fresh && code !== null && motionAllowed());
  useEffect(() => {
    if (code !== null && !hadCode.current) {
      hadCode.current = true;
      if (motionAllowed()) setPrinting(true);
    }
  }, [code]);

  if (code === null) return pending ? <PendingChip size={size} className={className} /> : null;
  return (
    <bdi
      dir="ltr"
      role="img"
      aria-label={code}
      data-printing={printing ? 'true' : undefined}
      onAnimationEnd={() => setPrinting(false)}
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-[3px] bg-[#F0B03A] font-mono font-semibold text-[#2E2100] tracking-[0.08em] whitespace-nowrap shadow-[inset_0_-1px_0_rgba(0,0,0,.12)]',
        size === 'large'
          ? 'px-2.5 pt-[7px] pb-1.5 text-[13px] leading-none'
          : 'px-1.5 pt-1 pb-[3px] text-[11.5px] leading-none',
        printing && 'motion-safe:animate-[kept-tape-print_520ms_cubic-bezier(.2,.7,.2,1)_both]',
        className,
      )}
    >
      <span aria-hidden="true">{printedCode(code)}</span>
    </bdi>
  );
}

/** The "ID pending" chip (D112): same size as the tape, dashed, no amber. */
function PendingChip({
  size,
  className,
}: {
  size: 'default' | 'large';
  className?: string | undefined;
}) {
  const { t } = useLingui();
  const label = t`ID pending`;
  return (
    <span
      role="img"
      aria-label={label}
      data-pending="true"
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-[3px] border border-dashed border-ink-3 font-medium text-ink-2 whitespace-nowrap',
        size === 'large'
          ? 'px-2.5 pt-[6px] pb-[5px] text-[13px] leading-none'
          : 'px-1.5 pt-[3px] pb-[2px] text-[11.5px] leading-none',
        className,
      )}
    >
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
