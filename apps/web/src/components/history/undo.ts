/**
 * Undo (D150, D124; plan T20 and T31): `POST /api/v1/audit/:eventId/undo` reverses one event
 * while its `undoable_until` window (7 days) is open. A refusal is 409 `undo_refused` with a
 * `reason` (api/capture/types.ts UndoRefusedDetails), which the toast says in words: "Can't
 * undo: Alfred changed Place since", with "Open the thing" to see what changed (screens §5).
 *
 * Two ways in:
 * - a history or activity row offers Undo on an event that qualifies (`useUndo().canUndo`); a
 *   thing's own timeline asks the server which of its events still can (`GET
 *   /things/:id/undoable`, timeline.tsx);
 * - after a write, `offerUndo()` shows a 10-second toast with Undo for the events the write
 *   recorded: the ids in its `X-Kept-Audit-Event` header (`written` in api/client.ts), one per
 *   thing for a bulk move. A write without the header recorded nothing undoable, and its toast
 *   has no Undo (or the caller's own fallback, such as restoring from Trash).
 *
 * Offline, Undo says it needs a connection (screens §3); a write still queued on the phone is
 * taken back locally by its own caller instead (the tray, the box check, "Undo this batch").
 *
 * The toast is announced politely and never takes focus (components/ui/toast.tsx).
 *
 * The server decides; the client only hides Undo where it would certainly be refused: someone
 * else's change unless you're an owner or admin there (the route's 403), or an expired window.
 */
import { useLingui } from '@lingui/react/macro';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { UndoRefusedDetails } from '@/api/capture/types';
import { api, isApiError } from '@/api/client';
import { inventoryPaths as p } from '@/api/inventory/paths';
import type { HistoryEvent, UndoResult } from '@/api/inventory/types';
import { useLocations, useMe } from '@/api/queries';
import { type ToastContentData, toast } from '@/components/ui/toast';
import { useFieldLabel } from './labels';

/**
 * The actions the server can undo (the handlers registered with `registerUndo` in apps/server:
 * things/undo.ts, places/undo.ts, capture/batch-undo.ts, inbox/bulk.ts, boxcheck/service.ts,
 * undo/registry.ts, codes/undo.ts, and step 4's paperwork/, money/, incidents/ and
 * schedules/undo.ts). A row whose action isn't here never offers Undo.
 */
export const UNDOABLE_ACTIONS: ReadonlySet<string> = new Set([
  'thing.update',
  'thing.retype',
  'thing.lifecycle',
  'thing.move',
  'thing.trash',
  'place.update',
  'place.move',
  'place.trash',
  'thing.capture',
  'capture.batch_undo',
  'thing.extract',
  'purchase.extract',
  'box.check',
  'inbox.bulk',
  // T17a (D208): own codes added, changed or removed (codes/undo.ts).
  'thing.codes',
  'place.codes',
  // Step 4 (D150, Q25; the plan's "undoable" rows), as registered so far: an expiring document
  // changed, deleted or renewed (paperwork/undo.ts); an exchange rate set or deleted and a
  // valuation changed or deleted (money/undo.ts); an incident changed, deleted, or its things
  // changed (incidents/undo.ts); a schedule deleted and a service record logged by completing,
  // changed or deleted (schedules/undo.ts). Plain creates never are (§7.7).
  'document.update',
  'document.delete',
  'document.renew',
  'fx_rate.set',
  'fx_rate.delete',
  'valuation.update',
  'valuation.delete',
  'incident.update',
  'incident.delete',
  'incident.things',
  'schedule.delete',
  'service_record.create',
  'service_record.update',
  'service_record.delete',
  // Step 5 (T19, T20): a reading logged or discarded (undo/registry.ts, meters/undo.ts), and a
  // draft service confirmed (services/drafts.ts). A draft itself isn't undoable: discard it.
  'reading.create',
  'reading.delete',
  'service_record.confirm',
  // Step 7 (T17): a consumable's "keep at least" set, changed or removed (consumables/).
  'thing.stock_rule',
]);

/** How long the Undo toast stays: 10 s (D150). */
export const UNDO_TOAST_MS = 10_000;

export const undoApi = {
  undo: (eventId: string) => api.post<UndoResult>(p.undo(eventId)),
};

type Who = { meId: string | undefined; roleIn: (locationId: string | null) => string | null };

/** Whether Undo is worth offering on this event (the server has the last word). */
export function isUndoable(e: HistoryEvent, who: Who, now = Date.now()): boolean {
  if (!UNDOABLE_ACTIONS.has(e.action) || e.undo_of || e.movedInFromElsewhere) return false;
  if (!e.undoable_until || Date.parse(e.undoable_until) <= now) return false;
  const role = who.roleIn(e.location_id);
  if (!role || role === 'viewer') return false;
  return e.actor.id === who.meId || role === 'owner' || role === 'admin';
}

/** After an undo, anything may show the old state again: refetch what's on screen. */
const refreshAll = (qc: QueryClient) => qc.invalidateQueries();

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Why an undo was refused, in words: `changed` is true when something changed since. */
export type Refusal = { title: string; changed: boolean };

/** A failed undo, said the way screens §5 says it. */
export function useUndoRefusal() {
  const { t } = useLingui();
  const fieldLabel = useFieldLabel();
  return useCallback(
    (err: unknown): Refusal => {
      if (isApiError(err) && err.code === 'offline')
        return { title: t`Undo needs a connection`, changed: false };
      const d: Partial<UndoRefusedDetails> = isApiError(err) ? err.details : {};
      switch (d.reason) {
        case 'changed_since': {
          const who = d.changedBy?.displayName;
          const field = d.field ? fieldLabel(d.field) : null;
          const title =
            who && field
              ? t`Can't undo: ${who} changed ${field} since`
              : who
                ? t`Can't undo: ${who} changed it since`
                : t`Can't undo: it changed since`;
          return { title, changed: true };
        }
        case 'already_undone':
          return { title: t`That was already undone`, changed: false };
        case 'expired':
          return { title: t`Can't undo: it's more than 7 days old`, changed: false };
        case 'not_undoable':
          return { title: t`That change can't be undone`, changed: false };
        default:
          return { title: t`Couldn't undo that`, changed: false };
      }
    },
    [t, fieldLabel],
  );
}

/**
 * The toasts after an undo: "Undone", or the refusal. When something changed since and the thing
 * is known, "Open the thing" goes to it (screens §5).
 */
function useReportUndo() {
  const { t } = useLingui();
  const refusal = useUndoRefusal();
  const navigate = useNavigate();
  return useCallback(
    (err: unknown | null, thingId?: string) => {
      if (!err) {
        toast({ title: t`Undone`, tone: 'ok' });
        return;
      }
      const r = refusal(err);
      const content: ToastContentData = { title: r.title, tone: 'danger' };
      if (r.changed && thingId)
        content.action = {
          label: t`Open the thing`,
          onAction: () => void navigate({ to: '/t/$id', params: { id: thingId } }),
        };
      toast(content, { timeout: UNDO_TOAST_MS });
    },
    [t, refusal, navigate],
  );
}

/** Undo on history rows: who may, and the action with its toasts. */
export function useUndo() {
  const qc = useQueryClient();
  const me = useMe();
  const locations = useLocations();
  const report = useReportUndo();
  const { t } = useLingui();
  const meId = me.data?.user.id;
  const list = locations.data;
  const roleIn = useCallback(
    (id: string | null) => list?.find((l) => l.id === id)?.role ?? null,
    [list],
  );
  const canUndo = useCallback((e: HistoryEvent) => isUndoable(e, { meId, roleIn }), [meId, roleIn]);
  const undo = useCallback(
    async (e: HistoryEvent) => {
      if (!online()) {
        toast({ title: t`Undo needs a connection`, tone: 'danger' });
        return;
      }
      const thingId = e.entity.type === 'thing' && e.entity.id ? e.entity.id : undefined;
      try {
        await undoApi.undo(e.id);
        await refreshAll(qc);
        report(null);
      } catch (err) {
        report(err, thingId);
      }
    },
    [qc, report, t],
  );
  return { canUndo, undo };
}

/**
 * Undoes a write's events, newest first (a bulk move has one per thing). Every one is tried; the
 * first refusal is what the caller reports.
 */
export async function undoEvents(eventIds: readonly string[]): Promise<void> {
  let refused: unknown = null;
  for (const id of [...eventIds].reverse()) {
    try {
      await undoApi.undo(id);
    } catch (err) {
      refused ??= err;
    }
  }
  if (refused) throw refused;
}

export type OfferUndoOptions = {
  /** The thing the write was about: a refusal because it changed offers "Open the thing". */
  thingId?: string;
  /** Undo for a write the server recorded nothing undoable for (restore from Trash, say). */
  fallback?: () => Promise<unknown>;
  /** After a successful undo (go back to the thing it brought back, say). */
  onUndone?: () => void;
};

/**
 * After a write: a toast saying what happened, for 10 s, with Undo when the write recorded
 * undoable events (`auditEvents` from `written`, the server's X-Kept-Audit-Event) or the caller
 * has a fallback. Without either, the toast simply has no Undo.
 */
export function useOfferUndo() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const report = useReportUndo();
  return useCallback(
    (
      content: { title: string; description?: string },
      auditEvents: readonly string[],
      opts: OfferUndoOptions = {},
    ) => {
      const run = auditEvents.length > 0 ? () => undoEvents(auditEvents) : (opts.fallback ?? null);
      toast(
        {
          ...content,
          tone: 'ok',
          ...(run
            ? {
                action: {
                  label: t`Undo`,
                  onAction: () => {
                    if (!online()) {
                      toast({
                        title: t`Undo needs a connection`,
                        description: t`Undo it from the history when you're back online.`,
                        tone: 'danger',
                      });
                      return;
                    }
                    void run()
                      .then(
                        () => {
                          report(null);
                          opts.onUndone?.();
                        },
                        (err: unknown) => report(err, opts.thingId),
                      )
                      // Part of a bulk undo may have gone through even when some was refused.
                      .finally(() => refreshAll(qc));
                  },
                },
              }
            : {}),
        },
        { timeout: UNDO_TOAST_MS },
      );
    },
    [qc, report, t],
  );
}
