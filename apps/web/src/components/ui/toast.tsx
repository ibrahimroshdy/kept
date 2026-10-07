/**
 * Toasts on React Aria's toast queue (not sonner: shadcn's aria base ships sonner, which is not
 * React Aria and pulls in next-themes; see docs/spikes/2026-09-26-s4.md).
 *
 * One app-level queue. Call `toast({ title })` from anywhere; <Toaster /> renders it once near
 * the root. The region is a landmark (F6 reaches it), toasts pause while hovered or focused, and
 * each has a Close button. Toasts sit at the bottom: full width on phones, at the inline end on
 * wider screens. It also keeps React Aria's announcer from naming what's gone (./announcer-guard.ts).
 */
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect } from 'react';
import {
  Button as ButtonPrimitive,
  Text,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_Toast as ToastPrimitive,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
} from 'react-aria-components';
import { XIcon } from '@/components/icons';
import { guardAnnouncer } from './announcer-guard';

export type ToastTone = 'neutral' | 'ok' | 'danger';

export type ToastContentData = {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** One optional action, e.g. Undo. The toast closes after it runs. */
  action?: { label: string; onAction: () => void };
};

export const toastQueue = new ToastQueue<ToastContentData>({ maxVisibleToasts: 3 });

/** Show a toast. Returns its key, for `toastQueue.close(key)`. Default timeout 5 s. */
export function toast(content: ToastContentData, options?: { timeout?: number }): string {
  return toastQueue.add(content, { timeout: options?.timeout ?? 5000 });
}

const toneBar: Record<ToastTone, string> = {
  neutral: 'bg-transparent',
  ok: 'bg-ok',
  danger: 'bg-danger',
};

/**
 * Where toasts sit: above the phone's tab bar (app-shell TabBar: 3.5rem, `md:hidden`, plus the
 * safe area), as the design board's phone frames have them; 1.5rem up from the corner on wider
 * screens. At `bottom-6` on a phone a toast covered Search and Inbox in the tab bar (found by the
 * step-3 e2e, T32).
 */
export const TOAST_REGION_POSITION =
  'fixed inset-x-3.5 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.75rem)] md:bottom-6 sm:inset-x-auto sm:end-6 sm:w-96';

export function Toaster({ queue = toastQueue }: { queue?: ToastQueue<ToastContentData> }) {
  const { t } = useLingui();
  // No announcement left naming a button that's gone (./announcer-guard.ts).
  useEffect(() => guardAnnouncer(), []);
  return (
    <ToastRegion
      queue={queue}
      aria-label={t`Notifications`}
      className={`${TOAST_REGION_POSITION} z-[60] flex flex-col-reverse gap-2 outline-none`}
    >
      {({ toast: item }) => (
        <ToastPrimitive
          toast={item}
          className="relative flex items-center gap-2.5 overflow-hidden rounded-[10px] bg-ink py-3 ps-4 pe-1.5 text-paper shadow-[0_10px_30px_rgba(0,0,0,.2)] outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-info"
        >
          <span
            aria-hidden="true"
            className={`absolute inset-y-0 start-0 w-1 ${toneBar[item.content.tone ?? 'neutral']}`}
          />
          {/* Announced politely (plan T31): React Aria's content is role="alert", which
              interrupts. Only a failure keeps that. Focus never moves to a toast. */}
          <ToastContent
            className="grid min-w-0 flex-1 gap-0.5"
            {...(item.content.tone === 'danger'
              ? {}
              : { role: 'status', 'aria-live': 'polite' as const })}
          >
            <Text slot="title" className="font-medium text-[14px] leading-snug">
              {item.content.title}
            </Text>
            {item.content.description ? (
              <Text slot="description" className="text-small opacity-80">
                {item.content.description}
              </Text>
            ) : null}
          </ToastContent>
          {item.content.action ? (
            <ButtonPrimitive
              className="min-h-10 cursor-pointer px-2 font-semibold text-[14px] underline outline-none data-focus-visible:outline-2 data-focus-visible:outline-info"
              onPress={() => {
                item.content.action?.onAction();
                queue.close(item.key);
              }}
            >
              {item.content.action.label}
            </ButtonPrimitive>
          ) : null}
          <ButtonPrimitive
            slot="close"
            aria-label={t`Close`}
            className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-lg outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:bg-white/10"
          >
            <XIcon />
          </ButtonPrimitive>
        </ToastPrimitive>
      )}
    </ToastRegion>
  );
}
