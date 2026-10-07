/**
 * A change made offline that couldn't apply (D35, engineering spec §5): "1 change couldn't apply:
 * Hallway closet was trashed by Alfred". Restore puts back what was trashed and applies the
 * change again; Dismiss (`d`) accepts the drop. Never silent.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { captureApi } from '@/api/capture/queries';
import type { InboxRestoreResult } from '@/api/capture/types';
import { Pill } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useInboxRun } from './actions';
import type { ItemProps } from './item-card';
import { useDropReasonText } from './labels';
import { BlockedReason, ItemShell, useItemKeys } from './shell';

export function SyncDropItem({ item, current, blocked }: ItemProps) {
  const { t } = useLingui();
  const reasonText = useDropReasonText();
  const { run, busy } = useInboxRun();
  const drop = item.syncDrop;
  const dismiss = () =>
    !blocked &&
    void run(() => captureApi.inboxDismiss(item.id, item.rowVersion), { done: t`Dismissed` });
  const restore = () =>
    !blocked &&
    void run(() => captureApi.inboxRestore(item.id, item.rowVersion), {
      done: (r: InboxRestoreResult) =>
        r.outcome === 'applied'
          ? t`Restored, and the change applied`
          : r.outcome === 'needs_review'
            ? t`Restored; the change waits in the inbox`
            : t`Restored, but the change still couldn't apply`,
    });
  useItemKeys(item.id, { accept: restore, drop: dismiss });
  if (!drop) return null;
  const entity = drop.entity?.name;
  const by = drop.by?.displayName;
  const canRestore = drop.reason === 'target_trashed';
  return (
    <ItemShell
      item={item}
      label={t`A change couldn't apply`}
      current={current}
      title={<Trans>A change made offline couldn't apply</Trans>}
      meta={
        <Pill tone="warn">
          <Trans>Couldn't sync</Trans>
        </Pill>
      }
      actions={
        <>
          {canRestore ? (
            <Button
              size="small"
              isDisabled={!!blocked}
              isPending={busy}
              aria-keyshortcuts="A"
              onPress={restore}
            >
              {entity ? <Trans>Restore {entity}</Trans> : <Trans>Restore</Trans>}
            </Button>
          ) : null}
          <Button
            size="small"
            variant="secondary"
            isDisabled={!!blocked}
            aria-keyshortcuts="D"
            onPress={dismiss}
          >
            <Trans>Dismiss</Trans>
          </Button>
          <BlockedReason reason={blocked} />
        </>
      }
    >
      <p className="m-0 text-small text-ink-2">
        {entity && by && drop.reason === 'target_trashed' ? (
          <Trans>
            <bdi>{entity}</bdi> was trashed by <bdi>{by}</bdi>.
          </Trans>
        ) : (
          reasonText(drop.reason)
        )}
      </p>
    </ItemShell>
  );
}
