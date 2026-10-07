/**
 * "Printed OK?" after the print dialog (screens §6): yes records the print date on the batch's
 * codes (`POST …/printed`, which keeps the first date), so "Label everything unprinted" and
 * Home's "Print your first label" stop counting them; no leaves everything as it was, to print
 * again. The first confirmed print shows the `labels.first_print` hint once (D138; T31's hint
 * system, components/hints/use-hint.ts): stick it on, then scan it. It opens by itself on
 * `hintAnchor` (the page's title), since the dialog just closed. Codes printed from "Print
 * pending labels" leave this phone's pending list.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type RefObject, useState } from 'react';
import { captureApi, captureKeys } from '@/api/capture/queries';
import type { LabelBatch } from '@/api/capture/types';
import { inventoryKeys } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { hintDone, useHint, useHints } from '@/components/hints/use-hint';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useOffline } from '@/offline/provider';
import { forgetPrintPending } from './pending-prompt';

const FIRST_PRINT = 'labels.first_print';

export function PrintedOkDialog({
  batch,
  isOpen,
  onClose,
  hintAnchor,
}: {
  batch: LabelBatch;
  isOpen: boolean;
  onClose: () => void;
  /** Where the first-print hint points. */
  hintAnchor: RefObject<Element | null>;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const offline = useOffline();
  const [tip, setTip] = useState(false);
  // The print view has no app shell to read these at start: read them here.
  const hints = useHints(isOpen || tip);
  useLocations();
  const firstPrint = hints.isSuccess && !hintDone(hints.data?.hints, FIRST_PRINT);
  useHint('labels.first_print', hintAnchor, { when: tip, autoOpen: true });

  const printed = useMutation({
    mutationFn: () => captureApi.labelBatchPrinted(batch.id),
    onSuccess: async (next) => {
      qc.setQueryData(captureKeys.labels.batch(batch.id), next);
      await forgetPrintPending(
        offline,
        batch.labels.flatMap((l) => (l.targetId ? [l.targetId] : [])),
      );
      void qc.invalidateQueries({ queryKey: captureKeys.labels.all });
      void qc.invalidateQueries({ queryKey: inventoryKeys.home });
      if (firstPrint) setTip(true);
      else toast({ title: t`Marked as printed`, tone: 'ok' });
      onClose();
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={(o) => !o && onClose()} className="print:hidden">
      <Dialog title={t`Printed OK?`} showClose={false}>
        <p className="m-0 text-ink-2">
          <Trans>
            Check that the labels sit inside their cells and that one scans. Yes records today as
            their print date.
          </Trans>
        </p>
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>No, print again</Trans>
          </Button>
          <Button onPress={() => printed.mutate()} isPending={printed.isPending}>
            <Trans>Yes, printed OK</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
