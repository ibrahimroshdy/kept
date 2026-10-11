/**
 * Keep/Discard at the end of the guided tour (spec §"Tour-data ledger", decision 3). The tour
 * engine shows it only when the ledger is non-empty — an empty `ids` renders nothing. Keep
 * (and dismissing, the safe default) leaves everything; Discard deletes exactly `ids`,
 * newest first, through the engine's deleter (the normal Trash-move mutations, so trashed
 * things wait 30 days and Activity rows stay as history), then says plainly what stayed
 * behind instead of claiming cleanup it didn't do. A full Discard finishes through `onKeep`,
 * so the engine marks `help.tour_seen`, clears the ledger and closes on one path.
 */

import { I18nProvider } from '@lingui/react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { I18nProvider as AriaI18nProvider } from 'react-aria-components';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { i18n } from '@/i18n/i18n';
import { discardLedger, type TourDeleter, type TourLedgerEntry } from './tour-ledger';

export function TourKeepDialog({
  ids,
  onKeep,
  onDiscard,
}: {
  /** This run's ledger (`tourLedger.list()`); empty renders no dialog. */
  ids: readonly TourLedgerEntry[];
  /** Keep, and dismiss: leave everything, let the engine finish up. */
  onKeep: () => void;
  /** One delete through an existing fetcher, wired by the tour engine. */
  onDiscard: TourDeleter;
}) {
  const { t } = useLingui();
  const [discarding, setDiscarding] = useState(false);
  const [failures, setFailures] = useState(0);
  // What this dialog already removed, by kind and id: a retry after a partial failure skips
  // these instead of deleting them twice (the second delete would fail — they're already
  // gone). A new run brings a new `ids` array and starts over (see below).
  const gone = useRef<Set<string>>(new Set());
  const prevIds = useRef(ids);
  if (prevIds.current !== ids) {
    prevIds.current = ids;
    gone.current = new Set();
  }

  if (ids.length === 0) return null;

  const discard = async () => {
    setDiscarding(true);
    setFailures(0);
    try {
      const result = await discardLedger(async (kind, id) => {
        const key = `${kind}:${id}`;
        if (gone.current.has(key)) return;
        await onDiscard(kind, id);
        gone.current.add(key);
      });
      if (result.kept.length === 0) onKeep();
      else setFailures(result.kept.length);
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open) => !open && onKeep()}>
      <Dialog title={t`Keep what you added?`} showClose={false}>
        <p className="m-0 text-ink-2">
          <Plural
            value={ids.length}
            one="The tour added # item to your library."
            other="The tour added # items to your library."
          />
        </p>
        <p className="m-0 text-ink-2">
          <Trans>
            Keep leaves everything where it is. Discard moves only what the tour added to Trash,
            where it waits 30 days before it's gone for good. Your activity history stays either
            way.
          </Trans>
        </p>
        {failures > 0 ? (
          <p role="alert" className="m-0 text-small font-medium text-danger">
            <Plural
              value={failures}
              one="# added item couldn't be removed. Check your connection and try Discard again, or Keep it."
              other="# added items couldn't be removed. Check your connection and try Discard again, or Keep them."
            />
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onKeep} isDisabled={discarding}>
            <Trans>Keep</Trans>
          </Button>
          <Button variant="danger" onPress={() => void discard()} isPending={discarding}>
            <Trans>Discard</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

/**
 * The Keep/Discard dialog with its own providers, for the tour engine's detached mount. The
 * engine shows it at the end of a run from wherever the tour happens to be, so it cannot rely
 * on the page above it: Lingui reads the app's shared `i18n` (already on this run's locale).
 */
export function TourKeepHost({
  ids,
  onKeep,
  onDiscard,
}: {
  ids: readonly TourLedgerEntry[];
  onKeep: () => void;
  onDiscard: TourDeleter;
}) {
  return (
    <I18nProvider i18n={i18n}>
      <AriaI18nProvider locale={i18n.locale}>
        <TourKeepDialog ids={ids} onKeep={onKeep} onDiscard={onDiscard} />
      </AriaI18nProvider>
    </I18nProvider>
  );
}
