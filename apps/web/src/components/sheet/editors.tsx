/**
 * The spreadsheet's cell editors (1.x, D250): what Enter, F2 or typing opens in a cell. Text and
 * numbers edit in the cell itself; a type, brand, person or condition is the app's Combobox in
 * the cell (never a native select); tags, a date and a place open a small popover anchored to the
 * cell. Every editor commits to the staged edits (nothing is sent until "Save N changes", D128):
 * Enter commits and moves down, Tab commits and moves across, Escape cancels.
 */
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { type RefObject, useMemo, useRef, useState } from 'react';
import {
  Dialog as AriaDialog,
  type Key,
  ListBox,
  ListBoxItem,
  Popover,
} from 'react-aria-components';
import { inventoryApi } from '@/api/inventory/queries';
import type { Condition, MoveTarget } from '@/api/inventory/types';
import { CheckIcon } from '@/components/icons';
import { useConditionLabels } from '@/components/things/labels';
import { useTypeOptions, WherePicker } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { cn } from '@/lib/utils';
import type { ColumnDef, EditKind } from './model';

/** Where the active cell goes after a commit. */
export type After = 'down' | 'up' | 'next' | 'prev' | null;

export type EditorProps = {
  column: ColumnDef;
  /** The cell's value in draft space (model.ts cellValue). */
  value: unknown;
  /** A key typed on the cell that opened the editor, which replaces the text. */
  seed?: string;
  accountId: string;
  locationId: string;
  /** The row's thing: never offered as its own box. */
  rowId: string;
  /** The cell, to anchor a popover editor to. */
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onCommit: (value: unknown, after: After) => void;
  onCancel: () => void;
};

/** The "None" choice, which clears a type, brand, person or condition. */
export const NONE = '__none';

const editorBox =
  'absolute inset-y-0 start-0 z-30 flex min-w-full items-center bg-surface shadow-[0_6px_20px_rgba(0,0,0,.16)]';
const cellInput =
  'h-full w-full min-w-0 border-2 border-info bg-surface px-2 font-[inherit] text-[14px] text-ink outline-none';

/** Popover editors are anchored to the cell; inline ones sit over it. */
export const POPOVER_EDITORS: ReadonlySet<EditKind> = new Set(['tags', 'date', 'place']);

export function CellEditor(props: EditorProps) {
  switch (props.column.edit) {
    case 'text':
    case 'number':
      return <TextEditor {...props} />;
    case 'type':
    case 'brand':
    case 'person':
    case 'condition':
      return <ChoiceEditor {...props} />;
    case 'tags':
      return <TagsEditor {...props} />;
    case 'date':
      return <DateEditor {...props} />;
    case 'place':
      return <PlaceEditor {...props} />;
    default:
      return null;
  }
}

/** Keys that leave a text editor: Enter (Shift: up), Tab (Shift: back), Escape. */
function leaveKey(e: React.KeyboardEvent): After | 'cancel' | undefined {
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Enter') return e.shiftKey ? 'up' : 'down';
  if (e.key === 'Tab') return e.shiftKey ? 'prev' : 'next';
  return undefined;
}

function TextEditor({ column, value, seed, label, onCommit, onCancel }: EditorProps) {
  const [text, setText] = useState(seed ?? String(value ?? ''));
  const done = useRef(false);
  const finish = (after: After | 'cancel') => {
    if (done.current) return;
    done.current = true;
    if (after === 'cancel') onCancel();
    else onCommit(text, after);
  };
  return (
    <div className={editorBox}>
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens because the person asked for it
        autoFocus
        aria-label={label}
        value={text}
        inputMode={column.edit === 'number' ? 'decimal' : 'text'}
        maxLength={column.max ? column.max + 50 : undefined}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          if (seed === undefined) e.currentTarget.select();
        }}
        onKeyDown={(e) => {
          const leave = leaveKey(e);
          if (!leave) return;
          e.preventDefault();
          e.stopPropagation();
          finish(leave);
        }}
        onBlur={() => finish(null)}
        className={cellInput}
      />
    </div>
  );
}

export type Option = ComboboxOption & { id: string };

/** The choices of a type, brand, person or condition cell, "None" first. */
export function useChoiceOptions(kind: EditKind, accountId: string): Option[] {
  const { t } = useLingui();
  const conditions = useConditionLabels();
  const types = useTypeOptions(kind === 'type' ? accountId : '');
  const registry = useQuery<{ items: { id: string; name?: string; displayName?: string }[] }>({
    queryKey: ['registry', kind === 'brand' ? 'brands' : 'people', accountId, { limit: 200 }],
    queryFn: () =>
      kind === 'brand'
        ? inventoryApi.registry('brands', accountId, { limit: 200 })
        : inventoryApi.registry('people', accountId, { limit: 200 }),
    enabled: (kind === 'brand' || kind === 'person') && !!accountId,
  });
  return useMemo(() => {
    const none: Option = { id: NONE, label: t`None` };
    switch (kind) {
      case 'condition':
        return [
          none,
          ...(Object.entries(conditions) as [Condition, string][]).map(([id, label]) => ({
            id,
            label,
          })),
        ];
      case 'type':
        return [none, ...types.options.map((o) => ({ ...o, id: String(o.id) }))];
      case 'brand':
        return [
          none,
          ...((registry.data?.items ?? []) as { id: string; name: string }[]).map((b) => ({
            id: b.id,
            label: b.name,
          })),
        ];
      case 'person':
        return [
          none,
          ...((registry.data?.items ?? []) as { id: string; displayName: string }[]).map((p) => ({
            id: p.id,
            label: p.displayName,
          })),
        ];
      default:
        return [];
    }
  }, [kind, t, conditions, types.options, registry.data]);
}

function ChoiceEditor({ column, value, accountId, label, onCommit, onCancel }: EditorProps) {
  const options = useChoiceOptions(column.edit as EditKind, accountId);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape on the closed combobox cancels the edit
    <div
      className={cn(
        editorBox,
        'p-0 [&_input]:min-h-0 [&_input]:rounded-none [&_input]:border-2 [&_input]:border-info [&_input]:py-1.5 [&_input]:text-[14px]',
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <Combobox<Option>
        aria-label={label}
        autoFocus
        menuTrigger="focus"
        className="w-full"
        items={options}
        defaultSelectedKey={(value as string | null) ?? NONE}
        defaultInputValue={
          options.find((o) => o.id === ((value as string | null) ?? NONE))?.label ?? ''
        }
        onSelectionChange={(k: Key | null) => {
          if (k === null) return;
          const id = String(k);
          onCommit(id === NONE ? null : id, null);
        }}
      />
    </div>
  );
}

/** A popover editor's frame: anchored to the cell, its own focus scope, Escape cancels. */
function EditorPopover({
  anchor,
  label,
  onCancel,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <Popover
      triggerRef={anchor}
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      placement="bottom start"
      offset={4}
      className="z-50 w-80 max-w-[90vw] rounded-[10px] border border-line bg-surface text-ink shadow-[0_10px_30px_rgba(0,0,0,.18)] outline-none"
    >
      <AriaDialog aria-label={label} className="grid gap-3 p-3 outline-none">
        {children}
      </AriaDialog>
    </Popover>
  );
}

function TagsEditor({ value, accountId, anchor, label, onCommit, onCancel }: EditorProps) {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((value as string[]) ?? []));
  const [q, setQ] = useState('');
  const tags = useQuery({
    queryKey: ['registry', 'tags', accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry('tags', accountId, { limit: 200 }),
    enabled: !!accountId,
  });
  const items = ((tags.data?.items ?? []) as { id: string; name: string }[]).filter((g) =>
    g.name.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()),
  );
  return (
    <EditorPopover anchor={anchor} label={label} onCancel={onCancel}>
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens because the person asked for it
        autoFocus
        aria-label={t`Search tags`}
        placeholder={t`Search tags`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-[15px] outline-none focus:border-info"
      />
      <ListBox
        aria-label={label}
        selectionMode="multiple"
        selectedKeys={chosen}
        onSelectionChange={(keys) =>
          setChosen(
            keys === 'all' ? new Set(items.map((g) => g.id)) : new Set([...keys].map(String)),
          )
        }
        items={items}
        renderEmptyState={() => (
          <div className="px-3 py-2 text-small text-ink-3">{t`No matches`}</div>
        )}
        className="grid max-h-56 gap-px overflow-y-auto outline-none"
      >
        {(g) => (
          <ListBoxItem
            id={g.id}
            textValue={g.name}
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-[15px] outline-none data-focused:bg-sunken"
          >
            {({ isSelected }) => (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-[5px] border-2 [&_svg]:size-3.5',
                    isSelected ? 'border-ink bg-ink text-paper' : 'border-ink-3',
                  )}
                >
                  {isSelected ? <CheckIcon strokeWidth="3" /> : null}
                </span>
                <bdi className="[overflow-wrap:anywhere]">{g.name}</bdi>
              </>
            )}
          </ListBoxItem>
        )}
      </ListBox>
      <div className="flex justify-end gap-2">
        <Button size="small" variant="secondary" onPress={onCancel}>
          {t`Cancel`}
        </Button>
        <Button size="small" onPress={() => onCommit([...chosen], null)}>
          {t`Done`}
        </Button>
      </div>
    </EditorPopover>
  );
}

function DateEditor({ value, anchor, label, onCommit, onCancel }: EditorProps) {
  const { t } = useLingui();
  const [day, setDay] = useState<string | null>((value as string | null) ?? null);
  return (
    <EditorPopover anchor={anchor} label={label} onCancel={onCancel}>
      <DatePicker label={label} value={day} onChange={setDay} />
      <div className="flex justify-end gap-2">
        <Button size="small" variant="ghost" onPress={() => onCommit(null, null)}>
          {t`Clear`}
        </Button>
        <Button size="small" onPress={() => onCommit(day, null)}>
          {t`Done`}
        </Button>
      </div>
    </EditorPopover>
  );
}

function PlaceEditor({ value, locationId, rowId, anchor, label, onCommit, onCancel }: EditorProps) {
  const target = value as MoveTarget;
  return (
    <EditorPopover anchor={anchor} label={label} onCancel={onCancel}>
      <WherePicker
        value={{ locationId, target }}
        allowOtherLocations={false}
        exclude={rowId}
        label={label}
        onChange={(v) => onCommit(v.target, null)}
      />
    </EditorPopover>
  );
}
