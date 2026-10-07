/**
 * A tooltip for icon-only controls (D198): React Aria's, so it opens on hover and on keyboard
 * focus, closes on Escape, and describes its trigger. The trigger keeps its own accessible name;
 * the tooltip only shows it. The child must be a React Aria control (Button) or an element
 * wrapped in `Focusable` that forwards its ref. `placement="end"` follows the text direction.
 */
import type { ReactElement, ReactNode } from 'react';
import {
  Tooltip as AriaTooltip,
  type TooltipProps as AriaTooltipProps,
  TooltipTrigger,
} from 'react-aria-components';

export function Tip({
  content,
  children,
  isDisabled = false,
  placement = 'end',
}: {
  content: ReactNode;
  children: ReactElement;
  isDisabled?: boolean;
  placement?: AriaTooltipProps['placement'];
}) {
  return (
    <TooltipTrigger delay={300} closeDelay={100} isDisabled={isDisabled}>
      {children}
      <AriaTooltip
        placement={placement}
        offset={8}
        className="z-50 max-w-64 rounded-md bg-ink px-2 py-1 text-[12.5px] leading-snug text-surface shadow-[0_6px_18px_rgba(0,0,0,.18)]"
      >
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
