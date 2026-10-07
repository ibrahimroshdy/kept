/**
 * Label (D120, D134, D137). The thing's short ID is permanent: its label reprints with the same
 * code (D45). This shows the code as it prints, lets you copy it, and opens the batch builder for
 * this one thing (plan T28), where the stock and start cell are chosen. With the Labels module
 * off it says so (screens §3).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { IdChip } from '@/components/id-chip';
import { LinkButton } from '@/components/page';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { DialogFooter } from '@/components/ui/dialog';
import { ModuleOff, useThingCtx } from './context';
import { Sheet } from './sheet';

export function LabelSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { thing, moduleOn, can } = useThingCtx();
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Label`}
    >
      {!moduleOn('labels') ? (
        <ModuleOff what={t`Labels & QR`} />
      ) : thing.shortCode ? (
        <div className="grid justify-items-start gap-3">
          <IdChip code={thing.shortCode} size="large" />
          <p className="m-0 text-small text-ink-2">
            <Trans>
              This code stays with {thing.name ?? ''} for good, so a reprinted label still finds it.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            {can('labels.use') ? (
              <LinkButton
                to="/labels"
                search={{ loc: thing.locationId, things: thing.id }}
                variant="primary"
                size="small"
              >
                <Trans>Print its label</Trans>
              </LinkButton>
            ) : null}
            <CopyButton text={thing.shortCode} label={t`Copy the code`} size="small" />
          </div>
        </div>
      ) : (
        <p className="m-0 text-ink-2">
          <Trans>Its ID is still being made. Try again in a moment.</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Done</Trans>
        </Button>
      </DialogFooter>
    </Sheet>
  );
}
