/**
 * Switch (shadcn aria base, restyled). The thumb moves with `margin-inline-start`, so "on" is at
 * the inline end in both directions without any `rtl:` overrides. Operated with Space.
 */
import {
  composeRenderProps,
  Switch as SwitchPrimitive,
  type SwitchProps as SwitchPrimitiveProps,
} from 'react-aria-components';
import { cn } from '@/lib/utils';

export type SwitchProps = SwitchPrimitiveProps;

export function Switch({ className, children, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive
      data-slot="switch"
      className={composeRenderProps(className, (cls) =>
        cn(
          'group inline-flex min-h-11 cursor-pointer items-center gap-3 text-[15px] text-ink outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50',
          cls,
        ),
      )}
      {...props}
    >
      {composeRenderProps(children, (children) => (
        <>
          <span
            aria-hidden="true"
            className="flex h-6 w-10 shrink-0 items-center rounded-full border border-line bg-sunken p-[3px] transition-colors group-data-selected:border-ok group-data-selected:bg-ok group-data-focus-visible:outline-2 group-data-focus-visible:outline-offset-2 group-data-focus-visible:outline-info"
          >
            <span className="block size-4 rounded-full bg-surface shadow-sm transition-[margin] group-data-selected:ms-4" />
          </span>
          {children}
        </>
      ))}
    </SwitchPrimitive>
  );
}
