/**
 * A form or action sheet: anchored to the bottom edge on phones, a centred dialog from `md` up
 * (plan Phase C: "forms are bottom sheets on phones with an explicit Save", L88). React Aria's
 * modal underneath, so focus is trapped and restored and Escape closes it.
 *
 * `fitKeyboard` (#130) is for a sheet whose content scrolls under a search field (the map's
 * shape picker): it follows the visual viewport, so on a phone it sits above the on-screen
 * keyboard and the browser's form bar and keeps one height while results change; its content
 * gets the rows that are left (a `min-h-0` grid row that scrolls).
 */
import type { CSSProperties, ReactNode } from 'react';
import { ModalOverlay, Modal as ModalPrimitive } from 'react-aria-components';
import { CloseOnBack } from '@/components/ui/close-on-back';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useVisibleBox } from '@/lib/visual-viewport';

export function Sheet({
  isOpen,
  onOpenChange,
  title,
  children,
  isDismissable = true,
  className,
  role,
  fitKeyboard = false,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode | ((opts: { close: () => void }) => ReactNode);
  isDismissable?: boolean;
  className?: string;
  role?: 'dialog' | 'alertdialog';
  /** Follow the visual viewport: stay above a phone's keyboard, at one height (#130). */
  fitKeyboard?: boolean;
}) {
  const box = useVisibleBox(fitKeyboard && isOpen);
  const overlayStyle = box
    ? ({
        top: box.top,
        height: box.height,
        bottom: 'auto',
        '--sheet-vh': `${box.height}px`,
      } as CSSProperties)
    : undefined;
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 grid items-end overflow-y-auto bg-black/35 md:place-items-center md:p-4"
      {...(overlayStyle ? { style: overlayStyle } : {})}
    >
      <ModalPrimitive
        data-fit-keyboard={fitKeyboard || undefined}
        className={cn(
          'w-full rounded-t-2xl border border-line bg-surface pb-[env(safe-area-inset-bottom)] text-ink shadow-[0_-10px_30px_rgba(0,0,0,.18)] outline-none md:max-w-lg md:rounded-xl md:shadow-[0_10px_30px_rgba(0,0,0,.2)]',
          fitKeyboard
            ? 'flex h-[calc(var(--sheet-vh,100dvh)*0.92)] flex-col overflow-hidden md:h-auto md:max-h-[calc(var(--sheet-vh,100dvh)*0.92)]'
            : 'max-h-[92dvh] overflow-y-auto',
          className,
        )}
      >
        <CloseOnBack />
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-10 flex-none rounded-full bg-line md:hidden"
        />
        <Dialog
          title={title}
          {...(role ? { role } : {})}
          {...(fitKeyboard ? { className: 'min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]' } : {})}
        >
          {({ close }) => (typeof children === 'function' ? children({ close }) : children)}
        </Dialog>
      </ModalPrimitive>
    </ModalOverlay>
  );
}
