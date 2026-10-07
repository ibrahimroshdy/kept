/**
 * A lost label claim (D43, D112, engineering spec §5): a blank label you claimed offline had
 * already been claimed on another phone. "This label was claimed on another phone for Box 3" ·
 * Open that box · Dismiss (your thing keeps its pending ID, and gets another label later).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { captureApi } from '@/api/capture/queries';
import { IdChip } from '@/components/id-chip';
import { Pill } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useInboxRun } from './actions';
import type { ItemProps } from './item-card';
import { BlockedReason, ItemShell, useItemKeys } from './shell';

export function ClaimItem({ item, current, blocked }: ItemProps) {
  const { t } = useLingui();
  const { run, busy } = useInboxRun();
  const dismiss = () =>
    !blocked &&
    void run(() => captureApi.inboxDismiss(item.id, item.rowVersion), { done: t`Dismissed` });
  useItemKeys(item.id, { drop: dismiss });
  const c = item.claim;
  if (!c) return null;
  const name = c.claimedFor.name;
  return (
    <ItemShell
      item={item}
      label={t`Label ${c.code}`}
      current={current}
      title={
        <Trans>
          Label <IdChip code={c.code} />
        </Trans>
      }
      meta={
        <Pill tone="warn">
          <Trans>Label already claimed</Trans>
        </Pill>
      }
      actions={
        <>
          {c.claimedFor.kind === 'thing' ? (
            <Link
              to="/t/$id"
              params={{ id: c.claimedFor.id }}
              className={cn(buttonClass('secondary', 'small'), 'no-underline')}
            >
              <Trans>Open {name}</Trans>
            </Link>
          ) : (
            <Link
              to="/p/$id"
              params={{ id: c.claimedFor.id }}
              className={cn(buttonClass('secondary', 'small'), 'no-underline')}
            >
              <Trans>Open {name}</Trans>
            </Link>
          )}
          <Button
            size="small"
            variant="ghost"
            isDisabled={!!blocked}
            isPending={busy}
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
        <Trans>
          This label was claimed on another phone for <bdi>{name}</bdi>. What you claimed it for
          keeps its pending ID; print it another label.
        </Trans>
      </p>
    </ItemShell>
  );
}
