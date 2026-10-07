/**
 * A form or picker as a bottom sheet on phones and a centred dialog from 768 px (L88: forms are
 * bottom sheets on phones, with an explicit Save). Built on React Aria's modal, so focus is
 * trapped and restored, Escape and Back close it (CloseOnBack), and the page behind is inert.
 *
 *   <Sheet isOpen={open} onOpenChange={setOpen} title={t`Add a room or spot`}>
 *     {({ close }) => <form>…</form>}
 *   </Sheet>
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
  role,
  wide = false,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode | ((opts: { close: () => void }) => ReactNode);
  role?: 'dialog' | 'alertdialog';
  /** A picker with a long list: taller, and wider on desktop. */
  wide?: boolean;
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 md:items-center md:p-4"
    >
      <ModalPrimitive
        className={cn(
          'max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface pb-[env(safe-area-inset-bottom)] text-ink shadow-[0_10px_30px_rgba(0,0,0,.2)] outline-none md:rounded-xl md:pb-0',
          wide ? 'md:max-w-xl' : 'md:max-w-md',
        )}
      >
        <CloseOnBack />
        <Dialog title={title} {...(role ? { role } : {})}>
          {({ close }) => (typeof children === 'function' ? children({ close }) : children)}
        </Dialog>
      </ModalPrimitive>
    </ModalOverlay>
  );
}
