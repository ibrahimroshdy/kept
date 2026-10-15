/**
 * The spreadsheet's bulk actions and its Columns choice (1.x, D250). Move, Tags and "Set a field"
 * stage the change on every selected row, to be checked and saved with "Save N changes" (D128);
 * Send to Trash is done at once, with Undo (D150), after an in-app confirmation that asks what
 * happens to what is inside a box (D45). Never a native select or window.confirm.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Key } from 'react-aria-components';
import { inventoryApi } from '@/api/inventory/queries';
import type { MoveTarget } from '@/api/inventory/types';
import { isChosen, WherePicker } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { ChoiceCards, Segmented } from '@/components/ui/segmented';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { TickBox } from '@/components/ui/tick-box';
import { NONE, useChoiceOptions } from './editors';
import { useColumnLabels } from './labels';
import { COLUMNS, type ColumnDef, type ColumnId, DEFAULT_COLUMNS } from './model';

/** "Move to…": a place or box in this location, for every selected row. */
export function MoveDialog({
  locationId,
  count,
  onClose,
  onPick,
}: {
  locationId: string;
  count: number;
  onClose: () => void;
  onPick: (to: MoveTarget) => void;
}) {
  const { t } = useLingui();
  const [target, setTarget] = useState<MoveTarget>({ placeId: '' });
  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={plural(count, { one: 'Move # thing', other: 'Move # things' })}
    >
      <div className="grid gap-4">
        <WherePicker
          value={{ locationId, target }}
          allowOtherLocations={false}
          onChange={(v) => setTarget(v.target)}
        />
        <p className="m-0 text-small text-ink-2">
          <Trans>
            The move waits with your other changes until you save. To move to another location, use
            Move on the list.
          </Trans>
        </p>
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isDisabled={!isChosen(target)} onPress={() => onPick(target)}>
            {t`Move`}
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}

/** "Tags…": add some tags to every selected row, or take them off. */
export function TagsDialog({
  accountId,
  count,
  onClose,
  onApply,
}: {
  accountId: string;
  count: number;
  onClose: () => void;
  onApply: (mode: 'add' | 'remove', tagIds: string[]) => void;
}) {
  const { t } = useLingui();
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const tags = useQuery({
    queryKey: ['registry', 'tags', accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry('tags', accountId, { limit: 200 }),
    enabled: !!accountId,
  });
  const items = ((tags.data?.items ?? []) as { id: string; name: string }[]).map((x) => ({
    id: x.id,
    name: x.name,
  }));
  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={plural(count, { one: 'Tags of # thing', other: 'Tags of # things' })}
    >
      <div className="grid gap-4">
        <Segmented<'add' | 'remove'>
          aria-label={t`Add or remove`}
          value={mode}
          onChange={setMode}
          options={[
            { id: 'add', label: t`Add tags` },
            { id: 'remove', label: t`Remove tags` },
          ]}
        />
        <Select<{ id: string; name: string }, 'multiple'>
          label={t`Tags`}
          selectionMode="multiple"
          items={items}
          value={tagIds}
          onChange={(keys: Key[]) => setTagIds(keys.map(String))}
          renderValue={(chosen) => chosen.map((x) => <bdi key={x.id}>{x.name}</bdi>)}
        >
          {(x) => (
            <SelectItem id={x.id} textValue={x.name}>
              <bdi>{x.name}</bdi>
            </SelectItem>
          )}
        </Select>
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isDisabled={tagIds.length === 0} onPress={() => onApply(mode, tagIds)}>
            {mode === 'add' ? t`Add tags` : t`Remove tags`}
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}

/** The fields "Set a field" offers: the editable ones that aren't Tags, Where or Name. */
const SETTABLE = COLUMNS.filter(
  (c) => c.edit && c.id !== 'name' && c.edit !== 'tags' && c.edit !== 'place',
);

/** "Set a field": one value for one field, on every selected row. */
export function SetFieldDialog({
  accountId,
  count,
  shown,
  onClose,
  onApply,
}: {
  accountId: string;
  count: number;
  /** The columns the reader may see (money and modules gated). */
  shown: readonly ColumnDef[];
  onClose: () => void;
  onApply: (column: ColumnDef, value: unknown) => void;
}) {
  const { t } = useLingui();
  const labels = useColumnLabels();
  const fields = SETTABLE.filter((c) => !c.money || shown.some((s) => s.id === c.id));
  const [field, setField] = useState<ColumnDef | null>(null);
  const [value, setValue] = useState<unknown>(null);
  const options = useChoiceOptions(field?.edit ?? 'text', accountId);
  const choice =
    field?.edit === 'type' ||
    field?.edit === 'brand' ||
    field?.edit === 'person' ||
    field?.edit === 'condition';
  const ready =
    !!field &&
    (field.edit === 'text' || field.edit === 'number'
      ? field.id === 'quantity'
        ? String(value ?? '').trim() !== ''
        : true
      : value !== undefined);
  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={plural(count, { one: 'Set a field on # thing', other: 'Set a field on # things' })}
    >
      <div className="grid gap-4">
        <Combobox
          label={t`Field`}
          menuTrigger="focus"
          items={fields.map((c) => ({ id: c.id, label: labels[c.id] }))}
          selectedKey={field?.id ?? null}
          onSelectionChange={(k) => {
            const next = fields.find((c) => c.id === k) ?? null;
            setField(next);
            setValue(next?.edit === 'text' || next?.edit === 'number' ? '' : undefined);
          }}
        />
        {field?.edit === 'text' || field?.edit === 'number' ? (
          <TextField
            key={field.id}
            label={labels[field.id]}
            value={String(value ?? '')}
            onChange={setValue}
            {...(field.edit === 'number' ? { inputProps: { inputMode: 'decimal' } } : {})}
            description={field.edit === 'text' ? t`Leave it empty to clear it.` : undefined}
          />
        ) : null}
        {choice ? (
          <Combobox
            key={(field as ColumnDef).id}
            menuTrigger="focus"
            label={labels[(field as ColumnDef).id]}
            items={options}
            selectedKey={value === undefined ? null : ((value as string | null) ?? NONE)}
            onSelectionChange={(k) => {
              if (k !== null) setValue(String(k) === NONE ? null : String(k));
            }}
          />
        ) : null}
        {field?.edit === 'date' ? (
          <DatePicker
            label={labels[field.id]}
            value={(value as string | null | undefined) ?? null}
            onChange={setValue}
            description={t`Leave it empty to clear it.`}
          />
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            isDisabled={!ready}
            onPress={() => field && onApply(field, field.edit === 'date' ? (value ?? null) : value)}
          >
            <Trans>Set</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}

/** Send to Trash: what happens to what is inside a box is asked first (D45). */
export function TrashDialog({
  count,
  holdsThings,
  isPending,
  onClose,
  onConfirm,
}: {
  count: number;
  holdsThings: boolean;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (contents: 'move' | 'trash' | undefined) => void;
}) {
  const { t } = useLingui();
  const [contents, setContents] = useState<'move' | 'trash'>('move');
  return (
    <Sheet
      isOpen
      role="alertdialog"
      isDismissable={false}
      onOpenChange={(o) => !o && onClose()}
      title={plural(count, {
        one: 'Send # thing to the Trash?',
        other: 'Send # things to the Trash?',
      })}
    >
      <div className="grid gap-4">
        {holdsThings ? (
          <ChoiceCards<'move' | 'trash'>
            label={t`Some of them hold things`}
            value={contents}
            onChange={setContents}
            options={[
              { id: 'move', title: t`Move what's inside out, to where each one is` },
              { id: 'trash', title: t`Trash what's inside too` },
            ]}
          />
        ) : null}
        <p className="m-0 text-small text-ink-2">
          <Trans>They stay in the Trash for 30 days. Undo brings them all back.</Trans>
        </p>
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="danger"
            isPending={isPending}
            onPress={() => onConfirm(holdsThings ? contents : undefined)}
          >
            <Trans>Send to Trash</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}

/** Columns: which ones this person sees, remembered on this device. Name is always there. */
export function ColumnsDialog({
  chosen,
  offered,
  onClose,
  onChange,
}: {
  chosen: readonly ColumnId[];
  /** The columns the reader may see (money and modules gated). */
  offered: readonly ColumnDef[];
  onClose: () => void;
  onChange: (ids: ColumnId[] | null) => void;
}) {
  const labels = useColumnLabels();
  const on = new Set(chosen);
  return (
    <Sheet isOpen onOpenChange={(o) => !o && onClose()} title={<Trans>Columns</Trans>}>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-x-4">
          {offered.map((c) => (
            <TickBox
              key={c.id}
              isSelected={c.id === 'name' || on.has(c.id)}
              isDisabled={c.id === 'name'}
              onChange={(v) => {
                const next = new Set(on);
                if (v) next.add(c.id);
                else next.delete(c.id);
                onChange(COLUMNS.map((x) => x.id).filter((id) => next.has(id)));
              }}
            >
              {labels[c.id]}
            </TickBox>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onPress={() => onChange(null)}>
            <Trans>Reset</Trans>
          </Button>
          <Button onPress={onClose}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}

export { DEFAULT_COLUMNS };
