/**
 * "A new version is ready · Reload" (D148; plan T23). Rendered once near the root. While a new
 * worker waits it asks the update gates (register.ts) every few seconds, and shows the toast
 * only when nothing is uploading and no capture is open. The toast stays until the person acts;
 * Reload checks the gates again, so a capture started in between still wins.
 */
import { useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';
import { type ToastContentData, toast, toastQueue } from '@/components/ui/toast';
import { appUpdates, type Updates, updateIsSafe, useUpdateState } from './register';

const closeToast = (key: string) => toastQueue.close(key);

export function UpdatePrompt({
  updates = appUpdates(),
  recheckMs = 5000,
  show = toast,
  close = closeToast,
}: {
  updates?: Updates | null;
  /** How often to ask the gates again while something is uploading. */
  recheckMs?: number;
  show?: (content: ToastContentData, options?: { timeout?: number }) => string;
  close?: (key: string) => void;
}) {
  const { t } = useLingui();
  const state = useUpdateState(updates);

  useEffect(() => {
    if (!updates || (state !== 'waiting' && state !== 'stale')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let key: string | null = null;

    const offer = async () => {
      if (cancelled) return;
      if (!(await updateIsSafe())) {
        timer = setTimeout(() => void offer(), recheckMs);
        return;
      }
      if (cancelled) return;
      key = show(
        {
          title: t`A new version is ready`,
          action: {
            label: t`Reload`,
            onAction: () => {
              key = null;
              // Busy again since the toast appeared: wait, then offer it again.
              void updates.apply().then((applied) => {
                if (!applied && !cancelled) timer = setTimeout(() => void offer(), recheckMs);
              });
            },
          },
        },
        { timeout: 0 },
      );
    };
    void offer();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (key) close(key);
    };
  }, [updates, state, recheckMs, show, close, t]);

  return null;
}
