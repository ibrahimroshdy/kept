/**
 * "New type": a name, where it sits in the tree, and an icon. Capabilities and fields come after,
 * in the editor, with the impact preview. The id is chosen here, so a retry never makes two.
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import type { TypeNode } from '@/api/inventory/types';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useTypeName } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useInvalidateTypes } from './api';
import { IconChoice } from './icon-choice';

export function NewTypeSheet({
  isOpen,
  onClose,
  accountId,
  types,
  parentId,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  accountId: string;
  types: readonly TypeNode[];
  parentId: string | null;
  onCreated: (id: string) => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`New type`}>
      {({ close }) => (
        <NewTypeForm
          accountId={accountId}
          types={types}
          initialParent={parentId}
          onCancel={close}
          onCreated={onCreated}
        />
      )}
    </Sheet>
  );
}

function NewTypeForm({
  accountId,
  types,
  initialParent,
  onCancel,
  onCreated,
}: {
  accountId: string;
  types: readonly TypeNode[];
  initialParent: string | null;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const errorText = useErrorText();
  const invalidate = useInvalidateTypes();
  const plain = types.filter((x) => !x.isFieldGroup);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(
    initialParent && plain.some((x) => x.id === initialParent) ? initialParent : null,
  );
  const [icon, setIcon] = useState(plain.find((x) => x.id === initialParent)?.icon ?? 'lucide:box');
  const [error, setError] = useState<string | null>(null);
  const [id] = useState(() => newId());
  const create = useMutation({
    mutationFn: () =>
      inventoryApi.createType(accountId, {
        id,
        parentId,
        name: name.trim(),
        icon,
        capabilities: [],
      }),
    onSuccess: async (created) => {
      await invalidate();
      const n = name.trim();
      toast({ title: t`Made ${n}`, tone: 'ok' });
      onCreated(created.id);
      onCancel();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError(t`Give the type a name, like Board game.`);
    if (n.length > 80) return setError(t`Keep the name to 80 characters.`);
    setError(null);
    create.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <TextField
        label={t`Name`}
        value={name}
        onChange={setName}
        autoFocus
        isRequired
        {...(error ? { errorMessage: error, isInvalid: true } : {})}
      />
      <Combobox
        label={t`Inside`}
        description={t`It inherits the capabilities and fields of the type it sits inside.`}
        items={[
          { id: '__top__', label: t`Top level` },
          ...plain
            .map((x) => ({ id: x.id, label: typeName(x) }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ]}
        selectedKey={parentId ?? '__top__'}
        onSelectionChange={(k) => k && setParentId(k === '__top__' ? null : String(k))}
      />
      <IconChoice value={icon} onChange={setIcon} />
      {create.error ? <Notice tone="danger">{errorText(create.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={create.isPending}>
          <Trans>Make the type</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
