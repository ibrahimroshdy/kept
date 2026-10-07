/**
 * Merge one brand, vendor, person or tag into another of the same account (D11; admin): every
 * thing that points at it points at the other, and it is gone. The common case is the duplicate
 * the add form just flagged, so the target can come preset.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { RegistryPathKind } from '@/api/inventory/paths';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { invalidateRegistry, registryApi, useRegistryAll } from './api';

export type MergeSubject = { id: string; name: string; accountId: string; targetId?: string };

export function MergeSheet({
  kind,
  subject,
  onClose,
  onMerged,
}: {
  kind: RegistryPathKind;
  subject: MergeSubject | null;
  onClose: () => void;
  onMerged?: (targetId: string) => void;
}) {
  const { t } = useLingui();
  const name = subject?.name ?? '';
  return (
    <Sheet
      isOpen={subject !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t`Merge ${name} into…`}
    >
      {({ close }) =>
        subject ? (
          <MergeForm kind={kind} subject={subject} onCancel={close} onMerged={onMerged} />
        ) : null
      }
    </Sheet>
  );
}

function MergeForm({
  kind,
  subject,
  onCancel,
  onMerged,
}: {
  kind: RegistryPathKind;
  subject: MergeSubject;
  onCancel: () => void;
  onMerged?: ((targetId: string) => void) | undefined;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const all = useRegistryAll(kind, subject.accountId);
  const [target, setTarget] = useState<string | null>(subject.targetId ?? null);
  const options = (all.data?.items ?? [])
    .filter((x) => x.id !== subject.id)
    .map((x) => ({ id: x.id, label: 'displayName' in x ? x.displayName : x.name }));
  const into = options.find((o) => o.id === target)?.label ?? '';
  const merge = useMutation({
    mutationFn: (to: string) => registryApi.mergeInto(kind, subject.id, to),
    onSuccess: async ({ repointed }, to) => {
      await invalidateRegistry(qc, kind);
      const from = subject.name;
      toast({
        title: t`Merged ${from} into ${into}`,
        description: plural(repointed, { one: '# thing updated.', other: '# things updated.' }),
        tone: 'ok',
      });
      onCancel();
      onMerged?.(to);
    },
  });
  const from = subject.name;
  return (
    <div className="grid gap-4">
      <p className="m-0 text-ink-2">
        <Trans>
          Everything that points at <bdi>{from}</bdi> will point at the one you choose, and{' '}
          <bdi>{from}</bdi> goes away. Its history stays with the things.
        </Trans>
      </p>
      <Combobox
        label={t`Merge into`}
        items={options}
        selectedKey={target}
        onSelectionChange={(k) => setTarget(k ? String(k) : null)}
      />
      {merge.error ? <Notice tone="danger">{errorText(merge.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          isDisabled={!target}
          isPending={merge.isPending}
          onPress={() => target && merge.mutate(target)}
        >
          {target ? <Trans>Merge into {into}</Trans> : <Trans>Merge</Trans>}
        </Button>
      </DialogFooter>
    </div>
  );
}
