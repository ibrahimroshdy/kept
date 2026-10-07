/**
 * A likely duplicate (D36): the same serial, or the same brand and model in the same place. Side
 * by side; Merge (`g`) asks which one survives, and merging keeps both histories (the survivor's
 * history includes the other's events, and the other's old labels open the survivor). Keep both
 * (`d`) says they're different things.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { captureApi } from '@/api/capture/queries';
import type { ThingRow } from '@/api/inventory/types';
import { IdChip } from '@/components/id-chip';
import { Pill } from '@/components/page';
import { PathText } from '@/components/places/rows';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useInboxRun } from './actions';
import type { ItemProps } from './item-card';
import { BlockedReason, ItemShell, useItemKeys } from './shell';

function Side({ label, thing, by }: { label: string; thing: ThingRow; by?: string }) {
  return (
    <div className="grid min-w-0 gap-1 rounded-[10px] border border-line p-3 text-small text-ink-2">
      <span className="eyebrow">{label}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-[14px] text-ink">
        <bdi className="[overflow-wrap:anywhere]">{thing.name}</bdi>
        <IdChip code={thing.shortCode} pending />
      </span>
      {thing.path.length ? <PathText path={thing.path} /> : null}
      {by ? <bdi>{by}</bdi> : null}
    </div>
  );
}

export function DuplicateReview({ item, current, blocked }: ItemProps) {
  const { t } = useLingui();
  const { run, busy } = useInboxRun();
  const [merging, setMerging] = useState(false);
  const d = item.duplicate;
  const draft = item.thing;
  // The one already in Kept survives unless the person says otherwise: it has the history and
  // the printed label.
  const [survivor, setSurvivor] = useState<string>(d?.other.id ?? '');
  const notDuplicate = () =>
    !blocked &&
    void run(() => captureApi.inboxNotDuplicate(item.id, item.rowVersion), {
      done: t`Kept both`,
    });
  useItemKeys(item.id, {
    merge: () => !blocked && setMerging(true),
    drop: notDuplicate,
  });
  if (!d || !draft) return null;

  const name = draft.name ?? t`Unnamed thing`;
  const survivorName = (survivor === draft.id ? draft.name : d.other.name) ?? name;
  const merge = () =>
    void run(() => captureApi.inboxMerge(item.id, { into: survivor }, item.rowVersion), {
      done: t`Merged into ${survivorName}`,
    });

  return (
    <ItemShell
      item={item}
      label={name}
      current={current}
      photo={draft.photos[0]}
      title={<bdi>{name}</bdi>}
      meta={
        <Pill tone="info">
          <Trans>Likely duplicate</Trans>
        </Pill>
      }
      actions={
        merging ? null : (
          <>
            <Button
              size="small"
              isDisabled={!!blocked}
              aria-keyshortcuts="G"
              onPress={() => setMerging(true)}
            >
              <Trans>Merge</Trans>
            </Button>
            <Button
              size="small"
              variant="secondary"
              isDisabled={!!blocked}
              isPending={busy}
              aria-keyshortcuts="D"
              onPress={notDuplicate}
            >
              <Trans>Not a duplicate · keep both</Trans>
            </Button>
            <BlockedReason reason={blocked} />
          </>
        )
      }
    >
      <div className="grid gap-2 @md:grid-cols-2">
        <Side label={t`This draft`} thing={draft} by={item.createdBy.displayName} />
        <Side label={t`Already in Kept`} thing={d.other} />
      </div>
      <p className="m-0 text-small text-ink-2">
        {d.reason === 'serial' ? (
          <Trans>Same serial number. Merging keeps both histories.</Trans>
        ) : (
          <Trans>Same brand and model in the same place. Merging keeps both histories.</Trans>
        )}
      </p>
      {merging ? (
        <div className="grid gap-3 rounded-[10px] border border-line p-3">
          <RadioGroup
            value={survivor}
            onChange={setSurvivor}
            aria-label={t`Which one stays`}
            className="grid gap-2"
          >
            <span className="font-semibold text-[14px] text-ink">
              <Trans>Which one stays?</Trans>
            </span>
            {[d.other, draft].map((th) => (
              <Radio
                key={th.id}
                value={th.id}
                className={({ isSelected, isFocusVisible }) =>
                  cn(
                    'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[14px]',
                    isSelected ? 'border-ink bg-sunken' : 'border-line',
                    isFocusVisible && 'outline-2 outline-offset-2 outline-info',
                  )
                }
              >
                {({ isSelected }) => (
                  <>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'grid size-4 shrink-0 place-items-center rounded-full border-2',
                        isSelected ? 'border-ink' : 'border-ink-3',
                      )}
                    >
                      {isSelected ? <span className="size-2 rounded-full bg-ink" /> : null}
                    </span>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {th.id === draft.id ? (
                        <Trans>
                          This draft, <bdi>{name}</bdi>
                        </Trans>
                      ) : (
                        <Trans>
                          The one already in Kept, <bdi>{th.name}</bdi>
                        </Trans>
                      )}
                    </span>
                  </>
                )}
              </Radio>
            ))}
          </RadioGroup>
          <div className="flex flex-wrap gap-2">
            <Button size="small" isPending={busy} isDisabled={!!blocked} onPress={merge}>
              <Trans>Merge into {survivorName}</Trans>
            </Button>
            <Button size="small" variant="secondary" onPress={() => setMerging(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : null}
    </ItemShell>
  );
}
