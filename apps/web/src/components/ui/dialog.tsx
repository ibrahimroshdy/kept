/**
 * Dialog (shadcn aria base, restyled). React Aria's idiom, three parts:
 *
 *   <DialogTrigger>
 *     <Button>Open</Button>
 *     <Modal>
 *       <Dialog title="Rename">{({ close }) => ...}</Dialog>
 *     </Modal>
 *   </DialogTrigger>
 *
 * or a controlled <Modal isOpen onOpenChange>. Focus is trapped and restored, Escape closes,
 * and the page behind is inert. The close button sits at the inline end.
 */
import { useLingui } from '@lingui/react/macro';
import type { ComponentProps, ReactNode } from 'react';
import {
  Button as ButtonPrimitive,
  Dialog as DialogPrimitive,
  type DialogProps as DialogPrimitiveProps,
  DialogTrigger,
  Heading,
  ModalOverlay,
  type ModalOverlayProps,
  Modal as ModalPrimitive,
} from 'react-aria-components';
import { XIcon } from '@/components/icons';
import { CloseOnBack } from '@/components/ui/close-on-back';
import { cn } from '@/lib/utils';

export { DialogTrigger };

export type ModalProps = Omit<ModalOverlayProps, 'className' | 'children'> & {
  className?: string;
  children: ReactNode;
};

export function Modal({ className, children, isDismissable = true, ...props }: ModalProps) {
  return (
    <ModalOverlay
      data-slot="modal-overlay"
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/35 p-4"
      {...props}
    >
      <ModalPrimitive
        data-slot="modal"
        className={cn(
          'w-full max-w-md rounded-xl border border-line bg-surface text-ink shadow-[0_10px_30px_rgba(0,0,0,.2)] outline-none',
          className,
        )}
      >
        <CloseOnBack />
        {children}
      </ModalPrimitive>
    </ModalOverlay>
  );
}

export type DialogProps = Omit<DialogPrimitiveProps, 'className'> & {
  title: ReactNode;
  className?: string;
  /** Hide the × button (confirmations, where the choice must be explicit). */
  showClose?: boolean;
};

export function Dialog({ title, children, className, showClose = true, ...props }: DialogProps) {
  const { t } = useLingui();
  return (
    <DialogPrimitive
      data-slot="dialog"
      className={cn('relative grid gap-4 p-5 outline-none', className)}
      {...props}
    >
      {(renderProps) => (
        <>
          <Heading
            slot="title"
            className={cn('m-0 font-semibold text-title text-ink', showClose && 'pe-10')}
          >
            {title}
          </Heading>
          {typeof children === 'function' ? children(renderProps) : children}
          {showClose ? (
            <ButtonPrimitive
              slot="close"
              aria-label={t`Close`}
              className="absolute top-3 end-3 grid size-11 cursor-pointer place-items-center rounded-[10px] text-ink-2 outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:bg-sunken"
            >
              <XIcon />
            </ButtonPrimitive>
          ) : null}
        </>
      )}
    </DialogPrimitive>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-wrap justify-end gap-2', className)}
      {...props}
    />
  );
}
