/**
 * The frame for pages outside the app: first-run setup, sign in, the second factor, the
 * magic-link confirm page and accepting an invite. Phone: full width. Desktop: a centred card,
 * with a rail of steps on the inline start when the flow has steps (the setup frame on the
 * screens board, 01-home-onboarding).
 */
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { LanguageToggle } from '@/components/display-prefs';
import { CheckIcon } from '@/components/icons';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Logo, VersionFooter } from './app-shell';

export type FrameStep = { label: ReactNode; state: 'done' | 'current' | 'todo' };

export function AuthFrame({
  title,
  eyebrow,
  intro,
  steps,
  railTitle,
  children,
  footer,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  intro?: ReactNode;
  steps?: FrameStep[];
  railTitle?: ReactNode;
  children: ReactNode;
  /** The action row at the bottom of the card. */
  footer?: ReactNode;
}) {
  const f = useFormat();
  return (
    // <main>: these pages stand alone, outside the app shell (axe: landmark-one-main, region).
    <main className="grid min-h-dvh content-start bg-surface md:place-items-center md:content-center md:bg-paper md:p-8">
      <div
        className={cn(
          'grid w-full bg-surface md:overflow-hidden md:rounded-xl md:border md:border-line md:shadow-[0_10px_30px_rgba(0,0,0,.06)]',
          steps ? 'md:max-w-4xl md:grid-cols-[236px_minmax(0,1fr)]' : 'md:max-w-lg',
        )}
      >
        {steps ? (
          <aside className="hidden flex-col gap-4 border-e border-line p-6 md:flex">
            <Logo />
            {railTitle ? <div className="font-semibold text-[15px]">{railTitle}</div> : null}
            <ol className="m-0 grid list-none gap-1.5 p-0">
              {steps.map((s, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are a fixed sequence
                  key={i}
                  aria-current={s.state === 'current' ? 'step' : undefined}
                  className={cn(
                    'flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-[14px]',
                    s.state === 'current'
                      ? 'border border-line bg-paper font-semibold text-ink'
                      : 'text-ink-2',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-6 shrink-0 place-items-center rounded font-semibold text-[12px] [&_svg]:size-4',
                      s.state === 'done' && 'bg-ok text-surface',
                      s.state === 'current' && 'bg-amber text-amber-ink',
                      s.state === 'todo' && 'bg-sunken text-ink-3',
                    )}
                  >
                    {s.state === 'done' ? <CheckIcon /> : f.num(i + 1)}
                  </span>
                  {s.label}
                </li>
              ))}
            </ol>
            <VersionFooter className="mt-auto" />
          </aside>
        ) : null}
        <section className="grid content-start gap-5 px-4 pt-4 pb-8 md:px-8 md:pt-7">
          <div className={cn('flex items-center justify-between gap-3', steps && 'md:hidden')}>
            <Logo />
            <LanguageToggle />
          </div>
          {steps ? (
            <div className="hidden justify-end md:flex">
              <LanguageToggle />
            </div>
          ) : null}
          <header className="grid gap-2">
            {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
            <h1 className="m-0 font-semibold text-[24px] leading-tight text-ink">{title}</h1>
            {intro ? <div className="text-ink-2">{intro}</div> : null}
          </header>
          {children}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              {footer}
            </div>
          ) : null}
          {steps ? null : <VersionFooter className="pt-2" />}
          {steps ? <VersionFooter className="pt-2 md:hidden" /> : null}
        </section>
      </div>
    </main>
  );
}

/**
 * "Step 2 of 3", in the reader's digits. Callers set it as an eyebrow (sans, small), never in
 * mono: D132 keeps mono for codes checked against a label (UI audit L3).
 */
export function StepCounter({ current, total }: { current: number; total: number }) {
  const f = useFormat();
  const step = f.num(current);
  const steps = f.num(total);
  return (
    <Trans>
      Step {step} of {steps}
    </Trans>
  );
}
