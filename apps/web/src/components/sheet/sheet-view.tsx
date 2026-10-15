/**
 * The spreadsheet view (1.x, D250; D39 item 2, D128, D150, D156): a location's things as rows and
 * columns, on a desktop. It is the location page's fourth layout (List · Grid · Map · Table),
 * loaded on demand (./lazy.tsx); phones keep the lists.
 *
 * - The list standard (L88, D205, D211): the same search, filters, saved views, sort, direction
 *   and grouping as the location's list, in the address; more sorts (brand, model, serial,
 *   quantity, expiry), also from the column headers. Rows come 100 a page from GET
 *   /things/sheet and load as you scroll; only the rows in view are drawn.
 * - Columns you pick, Name always first, remembered per person on this device.
 * - Edit in place: Enter, F2, a double-click or typing opens the cell; changes are staged (amber)
 *   behind "Save N changes" (D128), checked as the thing form checks them, and saved row by row
 *   with the version each was read at (D156). Rows that saved leave the bar; a row someone else
 *   changed stays staged with a marker: keep mine or keep theirs. One Undo takes the whole save
 *   back (POST /api/v1/audit/undo, all or none).
 * - Select rows (Space, Shift+arrows, Shift-click, Cmd/Ctrl-click, the boxes): Move to, Tags and
 *   Set a field stage on every one; Send to Trash goes at once, with Undo.
 * - A role="grid" with a roving tab stop: arrows (mirrored right to left), Home/End, PageUp/Down,
 *   Tab across, Escape, a visible focus ring. Viewers read; money only where it shows (D13).
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Dialog as AriaDialog, Popover } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { inventoryApi, inventoryKeys, useSheet } from '@/api/inventory/queries';
import type {
  BulkEditRowResult,
  MoveTarget,
  SheetParams,
  SheetRow,
  SheetSort,
  ThingListParams,
} from '@/api/inventory/types';
import { useMe } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { DisplayButton } from '@/components/filters/display';
import { ListExport } from '@/components/filters/list-export';
import { filterParams } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import { FilterStrip } from '@/components/filters/strip';
import type { FilterDef } from '@/components/filters/types';
import { useOfferUndo } from '@/components/history/undo';
import { AlertIcon, ArrowUpDownIcon, CheckIcon, ChevronDownIcon } from '@/components/icons';
import { ErrorState, LoadingRows, useErrorText } from '@/components/page';
import { invalidateBrowse, usePlaceTree } from '@/components/places/api';
import { accessOf } from '@/components/schedules/access';
import { useConditionLabels } from '@/components/things/labels';
import { useTypeName } from '@/components/things/names';
import { useLocationAccountId, useTypeOptions } from '@/components/things/pickers';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { directionOf, usePrefs } from '@/lib/prefs';
import { firstOf, useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import { ColumnsDialog, MoveDialog, SetFieldDialog, TagsDialog, TrashDialog } from './bulk';
import { type After, CellEditor, POPOVER_EDITORS } from './editors';
import { useColumnLabels, useSheetMessages } from './labels';
import {
  type Cell,
  COLUMNS,
  type ColumnDef,
  type ColumnId,
  cellValue,
  countStaged,
  DEFAULT_COLUMNS,
  type DraftKey,
  moveCell,
  NO_SELECTION,
  type RowSelection,
  readColumns,
  rebase,
  type Staged,
  selectAll,
  selectRange,
  stage,
  toEdits,
  toggleRow,
  unstage,
  validateDraft,
  visibleColumns,
  windowOf,
  writeColumns,
} from './model';

/** A row's height, and the header's, in CSS pixels: the window is computed from it. */
export const ROW = 40;
const SELECT_WIDTH = 44;
const PAGE = 100;
/** The server's limit on one bulk trash. */
const TRASH_MAX = 200;

type Item = { kind: 'group'; key: string; label: ReactNode } | { kind: 'row'; row: SheetRow };

type Dialog = 'move' | 'tags' | 'field' | 'trash' | 'columns' | null;

export default function SheetView({ location }: { location: LocationDetail }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const labels = useColumnLabels();
  const messages = useSheetMessages();
  const typeName = useTypeName();
  const f = useFilterRegistry();
  const { locale } = usePrefs();
  const rtl = directionOf(locale) === 'rtl';
  const name = useLocationName()(location);
  const [list, setList] = useListState();
  const me = useMe();
  const userId = me.data?.user.id ?? '';
  const access = accessOf(location);
  const canEdit = location.role !== 'viewer';
  const accountId = useLocationAccountId(location);
  const tree = usePlaceTree(location.id);
  const unplaced = tree.data?.places.find((pl) => pl.isUnplaced) ?? null;

  // ----- the query: the location's list filters, the sheet's sorts -----
  const where = firstOf(list, 'where');
  const importRunId = firstOf(list, 'importRun');
  const sort = (list.sort as SheetSort | undefined) ?? 'name';
  const listParams: ThingListParams = {
    locationId: location.id,
    ...(list.q ? { q: list.q } : {}),
    ...(list.group && list.group !== 'none' ? { group: list.group as 'type' } : {}),
    ...(list.dir ? { dir: list.dir } : {}),
    ...filterParams(list, {
      type: 'typeId',
      tag: 'tagId',
      state: 'state',
      brand: 'brandId',
      belongsTo: 'belongsToId',
    }),
    ...(importRunId ? { importRunId } : {}),
    ...(where === 'unplaced' && unplaced ? { placeId: unplaced.id } : {}),
  } as ThingListParams;
  const params: SheetParams = {
    ...listParams,
    ...(list.sort ? { sort } : {}),
    limit: PAGE,
  };
  const query = useSheet(params);
  const rows = useMemo(() => query.data?.pages.flatMap((pg) => pg.items) ?? [], [query.data]);
  const order = useMemo(() => rows.map((r) => r.id), [rows]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // ----- columns -----
  const [chosen, setChosen] = useState<readonly ColumnId[]>(DEFAULT_COLUMNS);
  useEffect(() => {
    if (userId) setChosen(readColumns(userId) ?? DEFAULT_COLUMNS);
  }, [userId]);
  const gate = { money: access.money, warranties: access.moduleOn('warranties') };
  const shown = visibleColumns(chosen, gate);
  const offered = visibleColumns(
    COLUMNS.map((c) => c.id),
    gate,
  );
  const lead = canEdit ? 1 : 0;
  const width = (canEdit ? SELECT_WIDTH : 0) + shown.reduce((n, c) => n + c.width, 0);

  // ----- what a cell shows -----
  const types = useTypeOptions(accountId);
  const registry = (kind: 'brands' | 'people' | 'tags') => ({
    queryKey: ['registry', kind, accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry(kind, accountId, { limit: 200 }),
    enabled: !!accountId && canEdit,
  });
  const brands = useQuery(registry('brands'));
  const people = useQuery(registry('people'));
  const tagList = useQuery(registry('tags'));
  const conditions = useConditionLabels();
  const money = useMoney();
  const nameOfId = useCallback((items: unknown, id: string | null, key: 'name' | 'displayName') => {
    if (!id) return '';
    const found = ((items as { items?: Record<string, string>[] } | undefined)?.items ?? []).find(
      (x) => x.id === id,
    );
    return found?.[key] ?? '';
  }, []);
  const placeName = useCallback(
    (to: MoveTarget, row: SheetRow): string => {
      if ('containerId' in to) return byId.get(to.containerId)?.name ?? t`A box`;
      const pl = tree.data?.places.find((p) => p.id === to.placeId);
      if (!pl) return row.path.map((s) => (s.isUnplaced ? t`Unplaced` : s.name)).join(' › ');
      return pl.isUnplaced ? t`Unplaced` : pl.name;
    },
    [byId, tree.data, t],
  );

  const [staged, setStaged] = useState<Staged>(new Map());
  const [failed, setFailed] = useState<ReadonlyMap<string, BulkEditRowResult>>(new Map());

  const text = (row: SheetRow, c: ColumnDef): string => {
    const v = c.field ? cellValue(row, staged, c.field) : undefined;
    const isStaged =
      !!c.field && !!staged.get(row.id)?.draft && c.field in (staged.get(row.id)?.draft ?? {});
    switch (c.id) {
      case 'name':
      case 'model':
      case 'serial':
      case 'barcode':
      case 'colour':
      case 'notes':
        return String(v ?? '');
      case 'quantity':
        return isStaged ? String(v ?? '') : fmt.num(row.quantity);
      case 'place':
        return isStaged
          ? placeName(v as MoveTarget, row)
          : row.path.map((s) => (s.isUnplaced ? t`Unplaced` : s.name)).join(' › ');
      case 'shortCode':
        return row.shortCode ?? '';
      case 'type': {
        if (!isStaged) return row.type ? (typeName(row.type) ?? '') : '';
        const opt = types.options.find((o) => o.id === v);
        return opt?.label ?? '';
      }
      case 'brand':
        return isStaged
          ? nameOfId(brands.data, v as string | null, 'name')
          : (row.brand?.name ?? '');
      case 'belongsTo':
        return isStaged
          ? nameOfId(people.data, v as string | null, 'displayName')
          : (row.belongsTo?.displayName ?? '');
      case 'tags':
        return isStaged
          ? (v as string[]).map((id) => nameOfId(tagList.data, id, 'name')).join(', ')
          : row.tags.map((g) => g.name).join(', ');
      case 'condition':
        return v ? conditions[v as keyof typeof conditions] : '';
      case 'expiresOn':
        return v ? fmt.day(v as string) : '';
      case 'purchasedOn':
        return row.purchase?.purchasedOn ? fmt.day(row.purchase.purchasedOn) : '';
      case 'price':
        return row.purchase?.moneyHidden
          ? t`Hidden in this location`
          : row.purchase?.price && row.purchase.currency
            ? money(row.purchase.price, row.purchase.currency)
            : '';
      case 'warranty':
        return row.warranty?.lifetime
          ? t`Lifetime`
          : row.warranty?.endsOn
            ? fmt.day(row.warranty.endsOn)
            : '';
      case 'lastSeen':
        return row.lastSeenAt ? fmt.day(row.lastSeenAt) : '';
      case 'updated':
        return fmt.day(row.updatedAt);
    }
  };

  // ----- groups -----
  const items = useMemo<Item[]>(() => {
    if (list.group !== 'type') return rows.map((row) => ({ kind: 'row', row }));
    const out: Item[] = [];
    let last: string | null = null;
    for (const row of rows) {
      const key = row.type?.id ?? '__none';
      if (key !== last) {
        out.push({ kind: 'group', key, label: typeName(row.type) ?? t`No type` });
        last = key;
      }
      out.push({ kind: 'row', row });
    }
    return out;
  }, [rows, list.group, typeName, t]);

  // ----- selection, the active cell, editing -----
  const [selection, setSelection] = useState<RowSelection>(NO_SELECTION);
  const [active, setActive] = useState<Cell>({ row: 0, col: lead });
  const [editing, setEditing] = useState<{ rowId: string; col: ColumnId; seed?: string } | null>(
    null,
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [saving, setSaving] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [problemFor, setProblemFor] = useState<string | null>(null);
  const wantFocus = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());
  const cols = lead + shown.length;

  const invalid = useMemo(() => {
    const out = new Map<string, Partial<Record<DraftKey, string>>>();
    for (const [id, s] of staged) {
      const row = byId.get(id);
      if (!row) continue;
      const e = validateDraft(row, s.draft, messages);
      if (Object.keys(e).length) out.set(id, e);
    }
    return out;
  }, [staged, byId, messages]);

  const rowIndexOf = useCallback(
    (index: number) => {
      const it = items[index];
      return it?.kind === 'row' ? it.row : null;
    },
    [items],
  );

  // The window of drawn rows is WindowedRows' own state: a scroll redraws the rows, not the page.
  const loadMore = () => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  };

  // Keep the active cell in view, and focus it when the keyboard moved it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = active.row * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + 2 * ROW > el.scrollTop + el.clientHeight && el.clientHeight > 0)
      el.scrollTop = top + 2 * ROW - el.clientHeight;
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const cell = cellRefs.current.get(`${active.row}:${active.col}`);
    cell?.focus({ preventScroll: true });
    cell?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const focusCell = (cell: Cell) => {
    wantFocus.current = true;
    setActive(cell);
  };

  const columnAt = (col: number): ColumnDef | null =>
    col < lead ? null : (shown[col - lead] ?? null);
  const editable = (c: ColumnDef | null) => canEdit && !!c?.edit;

  const startEdit = (cell: Cell, seed?: string) => {
    const row = rowIndexOf(cell.row);
    const c = columnAt(cell.col);
    if (!row || !c || !editable(c)) return;
    if (seed !== undefined && !(c.edit === 'text' || c.edit === 'number')) return;
    setEditing({ rowId: row.id, col: c.id, ...(seed !== undefined ? { seed } : {}) });
  };

  const commit = (row: SheetRow, c: ColumnDef, value: unknown, after: After) => {
    if (c.field) setStaged((s) => stage(s, row, c.field as DraftKey, value));
    setEditing(null);
    setFailed((m) => {
      if (!m.has(row.id)) return m;
      const next = new Map(m);
      next.delete(row.id);
      return next;
    });
    const step: Record<Exclude<After, null>, string> = {
      down: 'ArrowDown',
      up: 'ArrowUp',
      next: rtl ? 'ArrowLeft' : 'ArrowRight',
      prev: rtl ? 'ArrowRight' : 'ArrowLeft',
    };
    const moved = after ? moveCell(active, step[after], { rows: items.length, cols, rtl }) : null;
    focusCell(moved ?? active);
  };

  const toggle = (id: string) => setSelection((s) => toggleRow(s, id));

  // ----- keyboard -----
  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (editing || dialog) return;
    const target = e.target as HTMLElement;
    if (!target.dataset.cell) return;
    const mod = e.metaKey || e.ctrlKey;
    const row = rowIndexOf(active.row);
    if (mod && e.key.toLowerCase() === 'a' && canEdit) {
      e.preventDefault();
      setSelection(selectAll(order));
      return;
    }
    if (e.key === 'Escape') {
      if (selection.ids.size) {
        e.preventDefault();
        setSelection(NO_SELECTION);
      }
      return;
    }
    if (e.key === ' ' && canEdit && row) {
      e.preventDefault();
      toggle(row.id);
      return;
    }
    if ((e.key === 'Enter' || e.key === 'F2') && !mod) {
      e.preventDefault();
      if (active.col < lead && row) {
        if (failed.has(row.id)) setProblemFor(row.id);
        else toggle(row.id);
        return;
      }
      const c = columnAt(active.col);
      if (c?.id === 'shortCode' && row) {
        void navigate({ to: '/t/$id', params: { id: row.id } });
        return;
      }
      startEdit(active);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && row) {
      const c = columnAt(active.col);
      if (c && editable(c) && c.id !== 'name' && c.edit !== 'number' && c.edit !== 'place') {
        e.preventDefault();
        commit(row, c, c.edit === 'tags' ? [] : c.edit === 'text' ? '' : null, null);
      }
      return;
    }
    if (e.key === 'Tab') {
      const next = active.col + (e.shiftKey ? -1 : 1);
      if (next >= 0 && next < cols) {
        e.preventDefault();
        focusCell({ ...active, col: next });
      }
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1 && e.key !== ' ') {
      const c = columnAt(active.col);
      if (c && editable(c) && (c.edit === 'text' || c.edit === 'number')) {
        e.preventDefault();
        startEdit(active, e.key);
      }
      return;
    }
    const moved = moveCell(active, e.key, { rows: items.length, cols, rtl, ctrl: mod });
    if (!moved) return;
    e.preventDefault();
    let to = moved;
    // Group headings aren't cells: step over them.
    if (items[to.row]?.kind === 'group') {
      const dir = to.row >= active.row ? 1 : -1;
      const over = to.row + dir;
      to = over >= 0 && over < items.length ? { ...to, row: over } : active;
    }
    if (e.shiftKey && canEdit && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const target = rowIndexOf(to.row);
      if (target && row)
        setSelection((s) => selectRange(s.anchor ? s : { ...s, anchor: row.id }, order, target.id));
    }
    focusCell(to);
  };

  const onCellClick = (e: MouseEvent, cell: Cell, row: SheetRow) => {
    if (editing) return;
    if (canEdit && e.shiftKey) setSelection((s) => selectRange(s, order, row.id));
    else if (canEdit && (e.metaKey || e.ctrlKey)) toggle(row.id);
    else setSelection((s) => ({ ...s, anchor: row.id }));
    focusCell(cell);
  };

  // ----- save -----
  const counts = countStaged(staged);
  const save = async () => {
    if (saving || counts.cells === 0) return;
    if (invalid.size > 0) {
      toast({
        title: plural(invalid.size, {
          one: 'Fix # row before saving',
          other: 'Fix # rows before saving',
        }),
        tone: 'danger',
      });
      return;
    }
    setSaving(true);
    const okIds: string[] = [];
    const fresh: SheetRow[] = [];
    const events: string[] = [];
    const problems = new Map<string, BulkEditRowResult>();
    let cells = 0;
    try {
      for (const edits of toEdits(staged, order)) {
        const r = await inventoryApi.bulkEdit({ edits });
        for (const res of r.results) {
          if (res.ok) {
            okIds.push(res.id);
            cells += Object.keys(staged.get(res.id)?.draft ?? {}).length;
          } else problems.set(res.id, res);
        }
        fresh.push(...r.rows);
        events.push(...r.events);
      }
    } catch (err) {
      toast({ title: errorText(err), tone: 'danger' });
    } finally {
      setSaving(false);
    }
    if (okIds.length === 0 && problems.size === 0) return;
    setStaged((s) => unstage(s, okIds));
    setFailed(problems);
    // The saved rows change in place: a sheet doesn't reorder under the person's eyes.
    const freshById = new Map(fresh.map((r) => [r.id, r]));
    qc.setQueriesData<{ pages: { items: SheetRow[]; next_cursor: string | null }[] }>(
      { queryKey: ['things', 'sheet'] },
      (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((pg) => ({
                ...pg,
                items: pg.items.map((r) => freshById.get(r.id) ?? r),
              })),
            }
          : old,
    );
    void qc.invalidateQueries({
      predicate: (q) => !(q.queryKey[0] === 'things' && q.queryKey[1] === 'sheet'),
    });
    if (okIds.length)
      offerUndo(
        {
          title: plural(cells, { one: 'Saved # change', other: 'Saved # changes' }),
          ...(problems.size
            ? {
                description: plural(problems.size, {
                  one: "# row wasn't saved",
                  other: "# rows weren't saved",
                }),
              }
            : {}),
        },
        events,
        { together: true },
      );
    else
      toast({
        title: plural(problems.size, { one: "# row wasn't saved", other: "# rows weren't saved" }),
        tone: 'danger',
      });
  };

  const discard = async () => {
    if (
      await confirm({
        title: plural(counts.cells, {
          one: 'Discard # change?',
          other: 'Discard # changes?',
        }),
        confirmLabel: t`Discard`,
        destructive: true,
      })
    ) {
      setStaged(new Map());
      setFailed(new Map());
    }
  };

  // Cmd/Ctrl+S saves, anywhere in the sheet.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Leaving the sheet with unsaved changes asks first.
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (staged.size === 0) return false;
      const leavesSheet =
        current.pathname !== next.pathname || (next.search as { view?: string }).view !== 'table';
      if (!leavesSheet) return false;
      return !(await confirm({
        title: t`Leave without saving?`,
        body: plural(counts.cells, {
          one: "# change isn't saved yet.",
          other: "# changes aren't saved yet.",
        }),
        confirmLabel: t`Leave`,
        cancelLabel: t`Stay`,
        destructive: true,
      }));
    },
    enableBeforeUnload: () => staged.size > 0,
  });

  // ----- bulk -----
  const selectedRows = order
    .filter((id) => selection.ids.has(id))
    .map((id) => byId.get(id) as SheetRow);
  const stageAll = (field: DraftKey, valueFor: (row: SheetRow) => unknown) => {
    setStaged((s) => {
      let next = s;
      for (const row of selectedRows) next = stage(next, row, field, valueFor(row));
      return next;
    });
    setDialog(null);
  };
  const trash = async (contents: 'move' | 'trash' | undefined) => {
    setTrashing(true);
    try {
      const ids = selectedRows.map((r) => r.id);
      const r = await inventoryApi.bulkTrash({ thingIds: ids, ...(contents ? { contents } : {}) });
      setStaged((s) => unstage(s, r.trashed));
      setSelection(NO_SELECTION);
      setDialog(null);
      await invalidateBrowse(qc);
      offerUndo(
        {
          title: plural(r.trashed.length, {
            one: 'Sent # thing to the Trash',
            other: 'Sent # things to the Trash',
          }),
        },
        r.events,
        { together: true },
      );
    } catch (err) {
      const id = isApiError(err)
        ? (err.details as { thingId?: string } | undefined)?.thingId
        : undefined;
      const what = id ? (byId.get(id)?.name ?? '') : '';
      toast({ title: errorText(err), ...(what ? { description: what } : {}), tone: 'danger' });
    } finally {
      setTrashing(false);
    }
  };

  // ----- the strip -----
  const filters: FilterDef[] = [
    ...(unplaced ? [f.unplaced(unplaced.thingCount ?? 0)] : []),
    f.type(),
    f.tag(),
    f.state(['uncertain', 'draft', 'ended']),
    f.brand(),
    f.belongsTo(),
    ...(access.can('location.export-import') ? [f.importRun(location.id)] : []),
  ];
  const sorts = [
    { value: 'name', label: labels.name },
    { value: 'brand', label: labels.brand },
    { value: 'model', label: labels.model },
    { value: 'serial', label: labels.serial },
    { value: 'quantity', label: labels.quantity },
    { value: 'expires', label: labels.expiresOn, kind: 'due' as const },
    { value: 'updated', label: labels.updated, kind: 'date' as const },
    {
      value: 'lastSeen',
      label: labels.lastSeen,
      short: t({ message: 'Last seen', context: 'Display button' }),
      kind: 'date' as const,
    },
  ];
  const exportParams: ThingListParams = {
    ...listParams,
    ...(sort === 'name' || sort === 'updated' || sort === 'lastSeen' ? { sort } : {}),
  };
  const sortBy = (c: ColumnDef) => {
    if (!c.sort) return;
    const same = sort === c.sort;
    const date = c.sort === 'updated' || c.sort === 'lastSeen';
    const dir = same ? ((list.dir || (date ? 'desc' : 'asc')) === 'asc' ? 'desc' : 'asc') : '';
    setList({ sort: c.sort, dir });
  };
  const ariaSort = (c: ColumnDef): 'ascending' | 'descending' | undefined => {
    if (!c.sort || c.sort !== sort) return undefined;
    const date = c.sort === 'updated' || c.sort === 'lastSeen';
    return (list.dir || (date ? 'desc' : 'asc')) === 'asc' ? 'ascending' : 'descending';
  };

  const label = t`Things in ${name}`;
  const allSelected = order.length > 0 && selection.ids.size === order.length;
  const holdsThings = selectedRows.some((r) => r.isContainer);

  // ----- drawing -----
  const cellBase =
    'relative flex h-10 shrink-0 items-center overflow-hidden whitespace-nowrap border-line border-e px-2 text-[14px] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info';

  /** A click on a cell, read off the table (one handler, not one per cell): the select box,
   * Shift-click for a range, Cmd/Ctrl-click for one more row, or just the active cell. */
  const cellAt = (target: EventTarget): { cell: Cell; row: SheetRow } | null => {
    const td = (target as HTMLElement).closest?.('[data-cell]') as HTMLElement | null;
    const [r, c] = (td?.dataset.cell ?? '').split(':').map(Number);
    const row = r === undefined || Number.isNaN(r) ? null : rowIndexOf(r);
    return row && c !== undefined && !Number.isNaN(c)
      ? { cell: { row: r as number, col: c }, row }
      : null;
  };
  const onClick = (e: MouseEvent) => {
    const hit = cellAt(e.target);
    if (!hit || editing) return;
    if ((e.target as HTMLElement).closest('a')) return;
    const { cell, row } = hit;
    if (cell.col < lead) {
      if (failed.has(row.id)) {
        // The popover takes focus; moving it to the cell would close it again.
        setActive(cell);
        setProblemFor(row.id);
        return;
      }
      if (e.shiftKey) setSelection((s) => selectRange(s, order, row.id));
      else toggle(row.id);
      focusCell(cell);
      return;
    }
    onCellClick(e, cell, row);
  };
  const onDoubleClick = (e: MouseEvent) => {
    const hit = cellAt(e.target);
    if (hit && !editing) startEdit(hit.cell);
  };

  const renderRow = (index: number) => {
    const it = items[index];
    if (!it) return null;
    const style = { transform: `translateY(${index * ROW}px)`, width };
    if (it.kind === 'group')
      return (
        <tr
          key={`g:${it.key}:${index}`}
          aria-rowindex={index + 2}
          className="absolute top-0 flex h-10 border-line border-b bg-sunken"
          style={style}
        >
          <td
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a cell of the grid pattern (the table's role), named for assistive tech and tests
            role="gridcell"
            tabIndex={-1}
            colSpan={cols}
            className="eyebrow sticky start-0 flex items-center px-3"
          >
            {it.label}
          </td>
        </tr>
      );
    const row = it.row;
    const selected = selection.ids.has(row.id);
    const rowStaged = staged.get(row.id);
    const rowInvalid = invalid.get(row.id);
    const problem = failed.get(row.id);
    const cellRef = (key: string) => (el: HTMLTableCellElement | null) => {
      if (el) cellRefs.current.set(key, el);
      else cellRefs.current.delete(key);
    };
    return (
      <tr
        key={row.id}
        aria-rowindex={index + 2}
        aria-selected={canEdit ? selected : undefined}
        className={cn(
          'absolute top-0 flex border-line border-b',
          selected ? 'bg-sunken' : 'bg-surface',
        )}
        style={style}
      >
        {canEdit ? (
          <td
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a cell of the grid pattern (the table's role), named for assistive tech and tests
            role="gridcell"
            data-cell={`${index}:0`}
            ref={cellRef(`${index}:0`)}
            tabIndex={active.row === index && active.col === 0 ? 0 : -1}
            aria-label={problem ? t`Not saved: ${row.name ?? ''}` : t`Select ${row.name ?? ''}`}
            className={cn(
              cellBase,
              'sticky start-0 z-10 cursor-pointer justify-center bg-inherit px-0',
            )}
            style={{ width: SELECT_WIDTH }}
          >
            {problem ? (
              <AlertIcon aria-hidden="true" className="size-4 text-danger" />
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-[18px] place-items-center rounded-[5px] border-2 [&_svg]:size-3',
                  selected ? 'border-ink bg-ink text-paper' : 'border-ink-3',
                )}
              >
                {selected ? <CheckIcon strokeWidth="3" /> : null}
              </span>
            )}
            {problemFor === row.id && problem ? (
              <Problem
                anchor={{ current: cellRefs.current.get(`${index}:0`) ?? null }}
                row={row}
                problem={problem}
                onClose={() => {
                  setProblemFor(null);
                  focusCell({ row: index, col: 0 });
                }}
                onKeepMine={() => {
                  setStaged((s) => rebase(s, row.id, problem.rowVersion ?? row.rowVersion));
                  setFailed((m) => {
                    const next = new Map(m);
                    next.delete(row.id);
                    return next;
                  });
                  setProblemFor(null);
                  void qc.invalidateQueries({ queryKey: inventoryKeys.things.all });
                }}
                onKeepTheirs={() => {
                  setStaged((s) => unstage(s, [row.id]));
                  setFailed((m) => {
                    const next = new Map(m);
                    next.delete(row.id);
                    return next;
                  });
                  setProblemFor(null);
                  void qc.invalidateQueries({ queryKey: inventoryKeys.things.all });
                }}
              />
            ) : null}
          </td>
        ) : null}
        {shown.map((c, i) => {
          const col = i + lead;
          const key = `${index}:${col}`;
          const isEditing = editing?.rowId === row.id && editing.col === c.id;
          const isStaged = !!c.field && !!rowStaged && c.field in rowStaged.draft;
          const error = c.field ? rowInvalid?.[c.field] : undefined;
          const value = text(row, c);
          const isActive = active.row === index && active.col === col;
          return (
            <td
              key={c.id}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a cell of the grid pattern (the table's role), named for assistive tech and tests
              role="gridcell"
              data-cell={key}
              ref={cellRef(key)}
              tabIndex={isActive ? 0 : -1}
              aria-invalid={error ? true : undefined}
              {...(error ? { 'aria-description': error } : {})}
              title={error ?? (value || undefined)}
              className={cn(
                cellBase,
                i === 0 && 'sticky z-10 bg-inherit font-medium',
                i === 0 && (canEdit ? 'start-11' : 'start-0'),
                (c.id === 'quantity' || c.id === 'price') && 'justify-end tabular-nums',
                isStaged && 'bg-[color-mix(in_oklab,var(--amber)_22%,var(--surface))]',
                error && 'outline-2 -outline-offset-2 outline-danger outline-solid',
                !editable(c) && c.id !== 'shortCode' && 'text-ink-2',
              )}
              style={{ width: c.width }}
            >
              {c.id === 'shortCode' && row.shortCode ? (
                <Link
                  to="/t/$id"
                  params={{ id: row.id }}
                  tabIndex={-1}
                  className="font-mono text-[13px] text-ink underline-offset-2 hover:underline"
                >
                  {row.shortCode}
                </Link>
              ) : c.id === 'name' && !value ? (
                <span className="text-ink-3">{t`Untitled`}</span>
              ) : (
                <bdi className="min-w-0 overflow-hidden">{value}</bdi>
              )}
              {isEditing ? (
                <CellEditor
                  column={c}
                  value={c.field ? cellValue(row, staged, c.field) : null}
                  {...(editing?.seed !== undefined ? { seed: editing.seed } : {})}
                  accountId={accountId}
                  locationId={location.id}
                  rowId={row.id}
                  anchor={{ current: cellRefs.current.get(key) ?? null }}
                  label={`${labels[c.id]}: ${row.name ?? ''}`}
                  onCommit={(v, after) => commit(row, c, v, after)}
                  onCancel={() => {
                    setEditing(null);
                    focusCell({ row: index, col });
                  }}
                />
              ) : null}
            </td>
          );
        })}
      </tr>
    );
  };

  const popoverEditing = editing
    ? POPOVER_EDITORS.has(COLUMNS.find((c) => c.id === editing.col)?.edit ?? 'text')
    : false;

  return (
    <div className="grid min-w-0 gap-3">
      <FilterStrip
        filters={filters}
        surface="contents"
        search={{
          label: t`Search ${name}`,
          placeholder: t`Search ${name}`,
          end: (
            <span className="flex items-center gap-2">
              <Button size="small" variant="secondary" onPress={() => setDialog('columns')}>
                <Trans>Columns</Trans>
              </Button>
              <ListExport params={exportParams} />
            </span>
          ),
        }}
        display={
          <DisplayButton
            options={{
              sorts,
              groups: [
                { value: 'none', label: t`None` },
                { value: 'type', label: t`Type`, short: t`by type` },
              ],
              layouts: [
                { value: 'list', label: t`List` },
                { value: 'grid', label: t`Grid`, short: t`grid` },
                { value: 'map', label: t`Map`, short: t`map` },
                { value: 'table', label: t`Table`, short: t`table` },
              ],
            }}
            list={list}
            setList={setList}
          />
        }
      />

      {canEdit && selection.ids.size > 0 ? (
        <div
          role="toolbar"
          aria-label={t`Selection`}
          className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface p-2"
        >
          <span className="flex flex-1 items-center gap-2 ps-1 text-[14px] font-medium">
            <CheckIcon className="size-4" />
            <Trans>
              <span className="tabular-nums">{fmt.num(selection.ids.size)}</span> selected
            </Trans>
          </span>
          <Button size="small" onPress={() => setDialog('move')}>
            <Trans>Move to…</Trans>
          </Button>
          <Button size="small" variant="secondary" onPress={() => setDialog('tags')}>
            <Trans>Tags…</Trans>
          </Button>
          <Button size="small" variant="secondary" onPress={() => setDialog('field')}>
            <Trans>Set a field…</Trans>
          </Button>
          <Button
            size="small"
            variant="secondary"
            isDisabled={selection.ids.size > TRASH_MAX}
            onPress={() => setDialog('trash')}
          >
            <Trans>Send to Trash</Trans>
          </Button>
          <Button size="small" variant="ghost" onPress={() => setSelection(NO_SELECTION)}>
            <Trans>Clear</Trans>
          </Button>
          {selection.ids.size > TRASH_MAX ? (
            <p className="m-0 basis-full ps-1 text-small text-ink-2">
              <Trans>Send at most 200 to the Trash at a time.</Trans>
            </p>
          ) : null}
        </div>
      ) : null}

      {query.isPending ? (
        <LoadingRows label={t`Loading ${label}`} />
      ) : query.isError && rows.length === 0 ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <p className="m-0 rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-ink-2">
          {list.q || Object.keys(list.filters).length ? (
            <Trans>Nothing matches. Try fewer words or clear a filter.</Trans>
          ) : (
            <Trans>Nothing here yet</Trans>
          )}
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="relative max-h-[calc(100dvh-16rem)] min-h-80 overflow-auto rounded-[10px] border border-line bg-surface"
          data-testid="sheet-scroll"
        >
          <table
            ref={gridRef}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA's grid pattern on a table: cells are navigated and edited one by one (D250)
            role="grid"
            tabIndex={-1}
            aria-label={label}
            aria-rowcount={query.hasNextPage ? -1 : items.length + 1}
            aria-colcount={cols}
            aria-multiselectable={canEdit || undefined}
            aria-readonly={canEdit ? undefined : true}
            onKeyDown={onKeyDown}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            // Shift-click selects rows, not the text between them.
            onMouseDown={(e) => {
              if (e.shiftKey) e.preventDefault();
            }}
            className={cn('relative block border-collapse', popoverEditing && 'select-none')}
            style={{ width }}
          >
            <thead className="sticky top-0 z-20 block">
              <tr aria-rowindex={1} className="flex border-line border-b bg-sunken">
                {canEdit ? (
                  <th
                    scope="col"
                    className="sticky start-0 z-10 flex h-10 shrink-0 items-center justify-center border-line border-e bg-sunken"
                    style={{ width: SELECT_WIDTH }}
                  >
                    <button
                      type="button"
                      aria-label={allSelected ? t`Select none` : t`Select all`}
                      aria-pressed={allSelected}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelection(allSelected ? NO_SELECTION : selectAll(order));
                      }}
                      className="grid size-8 place-items-center rounded outline-none focus-visible:outline-2 focus-visible:outline-info"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'grid size-[18px] place-items-center rounded-[5px] border-2 [&_svg]:size-3',
                          allSelected ? 'border-ink bg-ink text-paper' : 'border-ink-3',
                        )}
                      >
                        {allSelected ? <CheckIcon strokeWidth="3" /> : null}
                      </span>
                    </button>
                  </th>
                ) : null}
                {shown.map((c, i) => (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={ariaSort(c)}
                    className={cn(
                      'eyebrow flex h-10 shrink-0 items-center border-line border-e bg-sunken px-2 text-start font-[inherit]',
                      i === 0 && 'sticky z-10',
                      i === 0 && (canEdit ? 'start-11' : 'start-0'),
                      (c.id === 'quantity' || c.id === 'price') && 'justify-end',
                    )}
                    style={{ width: c.width }}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        onClick={() => sortBy(c)}
                        className="flex min-w-0 items-center gap-1 rounded outline-none [font:inherit] [letter-spacing:inherit] [text-transform:inherit] focus-visible:outline-2 focus-visible:outline-info"
                      >
                        <span>{labels[c.id]}</span>
                        {ariaSort(c) ? (
                          <ChevronDownIcon
                            aria-hidden="true"
                            className={cn(
                              'size-3.5 shrink-0',
                              ariaSort(c) === 'ascending' && 'rotate-180',
                            )}
                          />
                        ) : (
                          <ArrowUpDownIcon
                            aria-hidden="true"
                            className="size-3.5 shrink-0 opacity-40"
                          />
                        )}
                      </button>
                    ) : (
                      <span>{labels[c.id]}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="relative block" style={{ height: items.length * ROW }}>
              <WindowedRows
                count={items.length}
                scrollRef={scrollRef}
                keep={active.row}
                render={renderRow}
                onNearEnd={loadMore}
              />
            </tbody>
          </table>
        </div>
      )}

      {query.hasNextPage ? (
        <Button
          variant="secondary"
          className="justify-self-center"
          isPending={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}

      {counts.cells > 0 || failed.size > 0 ? (
        <section
          aria-label={t`Changes`}
          className="sticky bottom-4 z-30 flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-surface p-3 shadow-[0_10px_30px_rgba(0,0,0,.14)]"
        >
          <p className="m-0 flex-1 text-[14px]">
            {plural(counts.cells, {
              one: '# change',
              other: '# changes',
            })}
            {' · '}
            {plural(counts.rows, { one: 'on # thing', other: 'on # things' })}
            {failed.size ? (
              <span className="ms-2 text-danger">
                {plural(failed.size, { one: "# row wasn't saved", other: "# rows weren't saved" })}
              </span>
            ) : null}
            {invalid.size ? (
              <span className="ms-2 text-danger">
                {plural(invalid.size, { one: '# row needs a fix', other: '# rows need a fix' })}
              </span>
            ) : null}
          </p>
          <Button
            variant="ghost"
            isDisabled={saving || counts.cells === 0}
            onPress={() => void discard()}
          >
            <Trans>Discard</Trans>
          </Button>
          <Button isPending={saving} isDisabled={counts.cells === 0} onPress={() => void save()}>
            {plural(counts.cells, { one: 'Save # change', other: 'Save # changes' })}
          </Button>
        </section>
      ) : null}

      {dialog === 'columns' ? (
        <ColumnsDialog
          chosen={chosen}
          offered={offered}
          onClose={() => setDialog(null)}
          onChange={(ids) => {
            setChosen(ids ?? DEFAULT_COLUMNS);
            if (userId) writeColumns(userId, ids);
          }}
        />
      ) : null}
      {dialog === 'move' ? (
        <MoveDialog
          locationId={location.id}
          count={selectedRows.length}
          onClose={() => setDialog(null)}
          onPick={(to) => stageAll('to', () => to)}
        />
      ) : null}
      {dialog === 'tags' ? (
        <TagsDialog
          accountId={accountId}
          count={selectedRows.length}
          onClose={() => setDialog(null)}
          onApply={(mode, tagIds) =>
            stageAll('tagIds', (row) => {
              const now = new Set(cellValue(row, staged, 'tagIds') as string[]);
              for (const id of tagIds) {
                if (mode === 'add') now.add(id);
                else now.delete(id);
              }
              return [...now];
            })
          }
        />
      ) : null}
      {dialog === 'field' ? (
        <SetFieldDialog
          accountId={accountId}
          count={selectedRows.length}
          shown={offered}
          onClose={() => setDialog(null)}
          onApply={(c, value) => c.field && stageAll(c.field, () => value)}
        />
      ) : null}
      {dialog === 'trash' ? (
        <TrashDialog
          count={selectedRows.length}
          holdsThings={holdsThings}
          isPending={trashing}
          onClose={() => setDialog(null)}
          onConfirm={(contents) => void trash(contents)}
        />
      ) : null}
    </div>
  );
}

/**
 * The rows in view and a few either side (model.ts windowOf), and the active one, which keeps
 * its tab stop when it scrolls away. Its own state, updated at most once a frame and only when
 * the window moves a row, so scrolling 5,000 rows redraws about 30, not the whole sheet. Near
 * the end it asks for the next page.
 */
function WindowedRows({
  count,
  scrollRef,
  keep,
  render,
  onNearEnd,
}: {
  count: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  keep: number;
  render: (index: number) => ReactNode;
  onNearEnd: () => void;
}) {
  const [win, setWin] = useState(() => windowOf(count, 0, 600, ROW));
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = windowOf(count, Math.max(0, el.scrollTop - ROW), el.clientHeight || 600, ROW);
      setWin((w) => (w.start === next.start && w.end === next.end ? w : next));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [count, scrollRef]);
  const nearEnd = useRef(onNearEnd);
  nearEnd.current = onNearEnd;
  useEffect(() => {
    if (win.end >= count - 20) nearEnd.current();
  }, [win.end, count]);
  const drawn = new Set<number>();
  for (let i = win.start; i < Math.min(win.end, count); i++) drawn.add(i);
  if (keep < count) drawn.add(keep);
  return <>{[...drawn].sort((a, b) => a - b).map(render)}</>;
}

/** Why a row wasn't saved, from its marker: keep mine or keep theirs after a 412 (D156). */
function Problem({
  anchor,
  row,
  problem,
  onClose,
  onKeepMine,
  onKeepTheirs,
}: {
  anchor: { current: HTMLElement | null };
  row: SheetRow;
  problem: BulkEditRowResult;
  onClose: () => void;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
}) {
  const { t } = useLingui();
  const who = problem.changedBy?.displayName;
  const name = row.name ?? '';
  const why =
    problem.status === 412
      ? who
        ? t`${who} changed this since you opened it.`
        : t`Someone changed this since you opened it.`
      : problem.status === 403
        ? t`You can view this location but not change it.`
        : problem.status === 404
          ? t`It's no longer here.`
          : (problem.hint ?? t`Check the highlighted cells.`);
  return (
    <Popover
      triggerRef={anchor}
      isOpen
      onOpenChange={(open) => !open && onClose()}
      placement="bottom start"
      className="z-50 w-80 max-w-[90vw] rounded-[10px] border border-line bg-surface text-ink shadow-[0_10px_30px_rgba(0,0,0,.18)] outline-none"
    >
      <AriaDialog
        aria-label={t`Not saved: ${row.name ?? ''}`}
        className="grid gap-3 p-3 outline-none"
      >
        <p className="m-0 text-[14px]">
          <bdi className="font-semibold">{name}</bdi> · {why}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {problem.status === 412 ? (
            <>
              <Button size="small" variant="secondary" onPress={onKeepTheirs}>
                <Trans>Keep theirs</Trans>
              </Button>
              <Button size="small" onPress={onKeepMine}>
                <Trans>Keep mine</Trans>
              </Button>
            </>
          ) : (
            <Button size="small" variant="secondary" onPress={onKeepTheirs}>
              <Trans>Discard my change</Trans>
            </Button>
          )}
        </div>
      </AriaDialog>
    </Popover>
  );
}
