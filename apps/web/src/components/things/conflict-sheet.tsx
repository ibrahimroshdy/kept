/**
 * D156's conflict sheet: only the fields that both people changed, each with both values and
 * three choices: Keep mine, Keep theirs, or Edit (back to the form, on that field). Everything
 * the other person changed alone was already taken silently by the merge.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import type { Conflict } from '@/lib/three-way';
import { Sheet } from './sheet';

export type Resolution = 'mine' | 'theirs' | 'edit';

export function ConflictSheet({
  pending,
  onResolve,
  onDismiss,
  display,
  label,
}: {
  pending: { conflicts: Conflict[]; changedBy: string | null } | null;
  session: unknown;
  onResolve: (choices: Record<string, Resolution>) => void;
  onDismiss: () => void;
  display: (path: string, value: unknown) => ReactNode;
  label: (path: string) => string;
}) {
  const { t } = useLingui();
  const [choices, setChoices] = useState<Record<string, Resolution>>({});
  useEffect(() => {
    if (pending) setChoices({});
  }, [pending]);
  if (!pending) return null;
  const who = pending.changedBy ?? t`Someone`;
  const allChosen = pending.conflicts.every((c) => choices[c.field]);
  const editing = pending.conflicts.some((c) => choices[c.field] === 'edit');
  return (
    <Sheet
      isOpen
      isDismissable={false}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      title={
        pending.conflicts.length === 1
          ? t`${who} changed this since you opened it`
          : t`${who} changed these since you opened them`
      }
    >
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Their other changes are already in. For each field below, choose which version to keep.
        </Trans>
      </p>
      <ul className="m-0 grid list-none gap-3 p-0">
        {pending.conflicts.map((c) => (
          <li
            key={c.field}
            data-conflict={c.field}
            className="grid gap-2 rounded-[10px] border border-line p-3"
          >
            <div className="font-semibold text-ink">{label(c.field)}</div>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
              <dt className="text-ink-3">
                <Trans>Yours</Trans>
              </dt>
              <dd className="m-0 text-ink [overflow-wrap:anywhere]">{display(c.field, c.mine)}</dd>
              <dt className="text-ink-3">{t`${who}'s`}</dt>
              <dd className="m-0 text-ink [overflow-wrap:anywhere]">
                {display(c.field, c.theirs)}
              </dd>
            </dl>
            <Segmented<Resolution>
              aria-label={t`Which ${label(c.field)} to keep`}
              value={choices[c.field] ?? ('' as Resolution)}
              onChange={(r) => setChoices((x) => ({ ...x, [c.field]: r }))}
              options={[
                { id: 'mine', label: t`Keep mine` },
                { id: 'theirs', label: t`Keep theirs` },
                { id: 'edit', label: t`Edit` },
              ]}
            />
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button variant="secondary" onPress={onDismiss}>
          <Trans>Not now</Trans>
        </Button>
        <Button isDisabled={!allChosen} onPress={() => onResolve(choices)}>
          {editing ? <Trans>Back to editing</Trans> : <Trans>Save</Trans>}
        </Button>
      </DialogFooter>
    </Sheet>
  );
}
