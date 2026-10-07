/**
 * A form or action sheet: anchored to the bottom edge on phones, a centred dialog from `md` up
 * (plan Phase C: "forms are bottom sheets on phones with an explicit Save", L88). React Aria's
 * modal underneath, so focus is trapped and restored and Escape closes it.
 */
import type { ReactNode } from 'react';
import { ModalOverlay, Modal as ModalPrimitive } from 'react-aria-components';
import { CloseOnBack } from '@/components/ui/close-on-back';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export function Sheet({
  isOpen,
  onOpenChange,
  title,
  children,
  isDismissable = true,
  className,
  role,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode | ((opts: { close: () => void }) => ReactNode);
  isDismissable?: boolean;
  className?: string;
  role?: 'dialog' | 'alertdialog';
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 grid items-end overflow-y-auto bg-black/35 md:place-items-center md:p-4"
    >
      <ModalPrimitive
        className={cn(
          'max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface pb-[env(safe-area-inset-bottom)] text-ink shadow-[0_-10px_30px_rgba(0,0,0,.18)] outline-none md:max-w-lg md:rounded-xl md:shadow-[0_10px_30px_rgba(0,0,0,.2)]',
          className,
        )}
      >
        <CloseOnBack />
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-line md:hidden" />
        <Dialog title={title} {...(role ? { role } : {})}>
          {({ close }) => (typeof children === 'function' ? children({ close }) : children)}
        </Dialog>
      </ModalPrimitive>
    </ModalOverlay>
  );
}
