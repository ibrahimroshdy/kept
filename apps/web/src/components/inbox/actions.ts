/**
 * Running an inbox action: the request, then the inbox and the things refreshed, and a toast. An
 * undoable one (bulk actions, discarding a draft: plan Q23) offers Undo the way every write does
 * (components/history/undo.ts): the events the server named in X-Kept-Audit-Event, or, from a
 * server that doesn't send the header yet, the `undo` in the body (T20's contract).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { captureKeys } from '@/api/capture/queries';
import type { UndoRef } from '@/api/capture/types';
import type { Written } from '@/api/client';
import { inventoryKeys } from '@/api/inventory/queries';
import { useOfferUndo } from '@/components/history/undo';
import { useErrorText } from '@/components/page';
import { toast } from '@/components/ui/toast';

/** The events to undo a write with: the header's, else the body's `undo`. */
export function undoEventsOf(w: Written<{ undo?: UndoRef } | undefined>): string[] {
  if (w.auditEvents.length > 0) return w.auditEvents;
  return w.body?.undo ? [w.body.undo.eventId] : [];
}

/**
 * Refetch what an inbox action may have changed: the inbox, the things it touched, and Home's
 * counts (the sidebar's Inbox badge reads `counts.inbox` from `/home`).
 */
export function useRefreshInbox() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: captureKeys.inbox.all }),
        qc.invalidateQueries({ queryKey: ['things'] }),
        qc.invalidateQueries({ queryKey: ['places'] }),
        qc.invalidateQueries({ queryKey: inventoryKeys.home }),
      ]),
    [qc],
  );
}

export type RunOptions<T> = {
  /** The toast after it worked; none when omitted. */
  done?: string | ((result: T) => string);
  /** The audit events that undo it. */
  undo?: (result: T) => readonly string[];
  /** The toast's title when it failed (default: the error in words). */
  failed?: string;
};

/**
 * `run(fn, opts)`: runs one action. Resolves to the result, or undefined when it failed (the
 * toast has said why). `busy` is true while one runs.
 */
export function useInboxRun() {
  const refresh = useRefreshInbox();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(fn: () => Promise<T>, opts: RunOptions<T> = {}): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await fn();
        await refresh();
        const title = typeof opts.done === 'function' ? opts.done(result) : opts.done;
        if (title) {
          const events = opts.undo?.(result) ?? [];
          if (events.length > 0) offerUndo({ title }, events);
          else toast({ title, tone: 'ok' });
        }
        return result;
      } catch (e) {
        await refresh();
        toast({
          title: opts.failed ?? errorText(e),
          ...(opts.failed ? { description: errorText(e) } : {}),
          tone: 'danger',
        });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refresh, errorText, offerUndo],
  );
  return { run, busy };
}
