/**
 * useConfirm(): the app's replacement for window.confirm, which Kept never uses (it can't be
 * styled, translated, or tested, and it blocks the page). Wrap the app in <ConfirmProvider>, then:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: t`Remove this member?`, confirmLabel: t`Remove`, destructive: true })) ...
 *
 * It renders an alertdialog: focus starts on Cancel, Escape cancels, and a click outside does
 * not dismiss it, so the choice is always explicit.
 */
import { useLingui } from '@lingui/react/macro';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Button } from './button';
import { Dialog, DialogFooter, Modal } from './dialog';

export type ConfirmOptions = {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as danger, for deletes and removals. */
  destructive?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm() needs a <ConfirmProvider> above it');
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    resolver.current?.(false);
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        isOpen={options !== null}
        isDismissable={false}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        {options ? (
          <Dialog role="alertdialog" title={options.title} showClose={false}>
            {options.body ? <div className="text-ink-2">{options.body}</div> : null}
            <DialogFooter>
              <Button variant="secondary" autoFocus onPress={() => settle(false)}>
                {options.cancelLabel ?? t`Cancel`}
              </Button>
              <Button
                variant={options.destructive ? 'danger' : 'primary'}
                onPress={() => settle(true)}
              >
                {options.confirmLabel ?? t`Confirm`}
              </Button>
            </DialogFooter>
          </Dialog>
        ) : null}
      </Modal>
    </ConfirmContext.Provider>
  );
}
