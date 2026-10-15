/**
 * The spreadsheet view's model (1.x, D250), pure so it is tested without a screen: its columns
 * and which are shown, the staged edits behind "Save N changes" (D128) and what they send
 * (D156: each row with the version it was read at), the row selection, and moving the active
 * cell by keyboard (mirrored right to left).
 *
 * Staged values live in "draft space", as the thing form's do (form-model.ts): text as typed,
 * the quantity as a string ("٢" is fine until Save), a choice as its id or null, tags as a sorted
 * id list, and the place as a MoveTarget. A value staged back to what the row holds unstages it.
 */
import type { Condition, MoveTarget, SheetRow, SheetSet, SheetSort } from '@/api/inventory/types';
import { parseNumber } from '@/components/things/form-model';

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

export type ColumnId =
  | 'name'
  | 'place'
  | 'shortCode'
  | 'type'
  | 'brand'
  | 'model'
  | 'serial'
  | 'quantity'
  | 'tags'
  | 'purchasedOn'
  | 'price'
  | 'warranty'
  | 'condition'
  | 'colour'
  | 'barcode'
  | 'belongsTo'
  | 'expiresOn'
  | 'notes'
  | 'lastSeen'
  | 'updated';

/** How a cell is edited in place; a column without one is read-only. */
export type EditKind =
  | 'text'
  | 'number'
  | 'type'
  | 'brand'
  | 'person'
  | 'condition'
  | 'tags'
  | 'place'
  | 'date';

export type Draft = {
  name?: string;
  quantity?: string;
  typeId?: string | null;
  brandId?: string | null;
  model?: string;
  serial?: string;
  barcode?: string;
  colour?: string;
  condition?: Condition | null;
  notes?: string;
  tagIds?: string[];
  belongsToPersonId?: string | null;
  expiresOn?: string | null;
  to?: MoveTarget;
};
export type DraftKey = keyof Draft;

export type ColumnDef = {
  id: ColumnId;
  edit?: EditKind;
  /** The staged field an edit writes. */
  field?: DraftKey;
  /** The server sort the header orders by (GET /things/sheet `sort`). */
  sort?: SheetSort;
  /** Its width in CSS pixels; the sheet scrolls sideways past the viewport. */
  width: number;
  /** The thing form's length limit. */
  max?: number;
  /** Shown only where the gate shows money (D13). */
  money?: true;
  /** Shown only where this module is on. */
  module?: 'warranties';
};

export const COLUMNS: readonly ColumnDef[] = [
  { id: 'name', edit: 'text', field: 'name', sort: 'name', width: 240, max: 200 },
  { id: 'place', edit: 'place', field: 'to', width: 220 },
  { id: 'shortCode', width: 104 },
  { id: 'type', edit: 'type', field: 'typeId', width: 170 },
  { id: 'brand', edit: 'brand', field: 'brandId', sort: 'brand', width: 150 },
  { id: 'model', edit: 'text', field: 'model', sort: 'model', width: 150, max: 120 },
  { id: 'serial', edit: 'text', field: 'serial', sort: 'serial', width: 150, max: 100 },
  { id: 'quantity', edit: 'number', field: 'quantity', sort: 'quantity', width: 96 },
  { id: 'tags', edit: 'tags', field: 'tagIds', width: 200 },
  { id: 'purchasedOn', width: 128 },
  { id: 'price', width: 128, money: true },
  { id: 'warranty', width: 140, module: 'warranties' },
  { id: 'condition', edit: 'condition', field: 'condition', width: 120 },
  { id: 'colour', edit: 'text', field: 'colour', width: 120, max: 60 },
  { id: 'barcode', edit: 'text', field: 'barcode', width: 150, max: 64 },
  { id: 'belongsTo', edit: 'person', field: 'belongsToPersonId', width: 160 },
  { id: 'expiresOn', edit: 'date', field: 'expiresOn', sort: 'expires', width: 140 },
  { id: 'notes', edit: 'text', field: 'notes', width: 240, max: 5000 },
  { id: 'lastSeen', sort: 'lastSeen', width: 128 },
  { id: 'updated', sort: 'updated', width: 128 },
];

const BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));
export const columnOf = (id: ColumnId): ColumnDef => BY_ID.get(id) as ColumnDef;

/** What a new sheet shows: the columns the issue names first. Name is always shown. */
export const DEFAULT_COLUMNS: readonly ColumnId[] = [
  'name',
  'place',
  'shortCode',
  'type',
  'brand',
  'model',
  'serial',
  'quantity',
  'tags',
  'purchasedOn',
  'price',
  'warranty',
];

/** The columns to draw: the chosen ones the reader may see, Name first, in the sheet's order. */
export function visibleColumns(
  chosen: readonly ColumnId[],
  gate: { money: boolean; warranties: boolean },
): ColumnDef[] {
  const want = new Set<ColumnId>(['name', ...chosen]);
  return COLUMNS.filter(
    (c) =>
      want.has(c.id) && (!c.money || gate.money) && (c.module !== 'warranties' || gate.warranties),
  );
}

const columnsKey = (userId: string) => `kept.sheet.columns.${userId}`;

/** The columns this person chose on this device, or null for the default. */
export function readColumns(userId: string): ColumnId[] | null {
  try {
    const raw = localStorage.getItem(columnsKey(userId));
    const ids: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(ids)) return null;
    const known = ids.filter(
      (x): x is ColumnId => typeof x === 'string' && BY_ID.has(x as ColumnId),
    );
    return known.length ? known : null;
  } catch {
    return null;
  }
}

export function writeColumns(userId: string, ids: readonly ColumnId[] | null): void {
  try {
    if (ids === null) localStorage.removeItem(columnsKey(userId));
    else localStorage.setItem(columnsKey(userId), JSON.stringify(ids));
  } catch {
    // Remembering is a convenience: this visit keeps the choice.
  }
}

// ---------------------------------------------------------------------------------------------
// Staged edits
// ---------------------------------------------------------------------------------------------

export type StagedRow = { rowVersion: number; draft: Draft };
export type Staged = ReadonlyMap<string, StagedRow>;

const TEXT_KEYS = new Set<DraftKey>(['name', 'model', 'serial', 'barcode', 'colour', 'notes']);

/** The row's own value of `key`, in draft space. */
export function originalOf(row: SheetRow, key: DraftKey): Draft[DraftKey] {
  switch (key) {
    case 'name':
      return row.name ?? '';
    case 'quantity':
      return String(row.quantity);
    case 'typeId':
      return row.type?.id ?? null;
    case 'brandId':
      return row.brand?.id ?? null;
    case 'model':
    case 'serial':
    case 'barcode':
    case 'colour':
    case 'notes':
      return row[key] ?? '';
    case 'condition':
      return row.condition;
    case 'tagIds':
      return row.tags.map((g) => g.id).sort();
    case 'belongsToPersonId':
      return row.belongsTo?.id ?? null;
    case 'expiresOn':
      return row.expiresOn;
    case 'to':
      return row.containerId ? { containerId: row.containerId } : { placeId: row.placeId ?? '' };
  }
}

function norm(key: DraftKey, v: unknown): string {
  if (TEXT_KEYS.has(key)) return JSON.stringify(String(v ?? '').trim());
  if (key === 'tagIds') return JSON.stringify([...((v as string[]) ?? [])].sort());
  if (key === 'quantity') {
    const n = parseNumber(String(v ?? ''));
    return n === null || Number.isNaN(n) ? JSON.stringify(String(v ?? '')) : String(n);
  }
  return JSON.stringify(v ?? null);
}

/** Whether `value` is the row's own value of `key` (text compared trimmed). */
export const isOriginal = (row: SheetRow, key: DraftKey, value: unknown) =>
  norm(key, value) === norm(key, originalOf(row, key));

/** `staged` with `row`'s `key` set to `value`; back to the row's own value, it is unstaged. */
export function stage(staged: Staged, row: SheetRow, key: DraftKey, value: unknown): Staged {
  const next = new Map(staged);
  const entry = next.get(row.id) ?? { rowVersion: row.rowVersion, draft: {} };
  const draft: Draft = { ...entry.draft };
  if (isOriginal(row, key, value)) delete draft[key];
  else
    (draft as Record<string, unknown>)[key] =
      key === 'tagIds' ? [...(value as string[])].sort() : value;
  if (Object.keys(draft).length === 0) next.delete(row.id);
  else next.set(row.id, { rowVersion: entry.rowVersion, draft });
  return next;
}

/** The value a cell shows: the staged one, else the row's. */
export function cellValue(row: SheetRow, staged: Staged, key: DraftKey): Draft[DraftKey] {
  const draft = staged.get(row.id)?.draft;
  return draft && key in draft ? draft[key] : originalOf(row, key);
}

/** How many cells are staged, over how many rows. */
export function countStaged(staged: Staged): { cells: number; rows: number } {
  let cells = 0;
  for (const s of staged.values()) cells += Object.keys(s.draft).length;
  return { cells, rows: staged.size };
}

export type Messages = {
  nameRequired: string;
  tooLong: (max: number) => string;
  quantity: string;
  quantityFixed: string;
};

/** The thing form's checks (form-model.ts validate), for the staged fields of one row. */
export function validateDraft(
  row: SheetRow,
  draft: Draft,
  m: Messages,
): Partial<Record<DraftKey, string>> {
  const e: Partial<Record<DraftKey, string>> = {};
  for (const [key, value] of Object.entries(draft) as [DraftKey, unknown][]) {
    if (TEXT_KEYS.has(key)) {
      const text = String(value ?? '').trim();
      const max = COLUMNS.find((c) => c.field === key)?.max;
      if (key === 'name' && text === '') e.name = m.nameRequired;
      else if (max && text.length > max) e[key] = m.tooLong(max);
    }
    if (key === 'quantity') {
      const q = parseNumber(String(value ?? ''));
      if (q === null || Number.isNaN(q) || q < 0 || !Number.isInteger(q)) e.quantity = m.quantity;
      else if (row.quantityFixed && q !== 1) e.quantity = m.quantityFixed;
    }
  }
  return e;
}

/** A staged row in wire types: blank text clears (null), the name is trimmed. */
export function toSet(draft: Draft): SheetSet {
  const set: SheetSet = {};
  for (const [key, value] of Object.entries(draft) as [DraftKey, unknown][]) {
    if (key === 'name') set.name = String(value).trim();
    else if (TEXT_KEYS.has(key)) {
      const text = String(value ?? '').trim();
      (set as Record<string, unknown>)[key] = text === '' ? null : text;
    } else if (key === 'quantity') set.quantity = parseNumber(String(value)) ?? 0;
    else (set as Record<string, unknown>)[key] = value;
  }
  return set;
}

/** The staged rows as BulkEditBody edits, `max` a request, in the sheet's row order. */
export function toEdits(
  staged: Staged,
  order: readonly string[],
  max = 200,
): { id: string; rowVersion: number; set: SheetSet }[][] {
  const ids = [
    ...order.filter((id) => staged.has(id)),
    ...[...staged.keys()].filter((id) => !order.includes(id)),
  ];
  const edits = ids.map((id) => {
    const s = staged.get(id) as StagedRow;
    return { id, rowVersion: s.rowVersion, set: toSet(s.draft) };
  });
  const out: (typeof edits)[] = [];
  for (let i = 0; i < edits.length; i += max) out.push(edits.slice(i, i + max));
  return out;
}

/** "Keep mine" after a 412 (D156): the staged row re-based on the version the server has now. */
export function rebase(staged: Staged, id: string, rowVersion: number): Staged {
  const s = staged.get(id);
  if (!s) return staged;
  const next = new Map(staged);
  next.set(id, { ...s, rowVersion });
  return next;
}

export function unstage(staged: Staged, ids: Iterable<string>): Staged {
  const next = new Map(staged);
  for (const id of ids) next.delete(id);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

export type RowSelection = { ids: ReadonlySet<string>; anchor: string | null };
export const NO_SELECTION: RowSelection = { ids: new Set(), anchor: null };

/** Cmd/Ctrl-click and Space: one row in or out; it becomes the anchor. */
export function toggleRow(sel: RowSelection, id: string): RowSelection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/** Shift-click and Shift+arrows: every row from the anchor to `id` is added; the anchor stays. */
export function selectRange(sel: RowSelection, order: readonly string[], id: string): RowSelection {
  const anchor = sel.anchor ?? id;
  const a = order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return toggleRow(sel, id);
  const ids = new Set(sel.ids);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ids.add(order[i] as string);
  return { ids, anchor };
}

export const selectAll = (order: readonly string[]): RowSelection => ({
  ids: new Set(order),
  anchor: order[0] ?? null,
});

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

export type Cell = { row: number; col: number };

/**
 * The cell a key moves to, in a grid of `rows` × `cols`: arrows (Left and Right swapped right to
 * left, so the arrow points where the cell is), Home/End along the row (with Ctrl or Cmd, to the
 * first or last row), PageUp/PageDown by `page` rows. Null for any other key.
 */
export function moveCell(
  cell: Cell,
  key: string,
  grid: { rows: number; cols: number; rtl: boolean; ctrl?: boolean; page?: number },
): Cell | null {
  const clampRow = (r: number) => Math.max(0, Math.min(grid.rows - 1, r));
  const clampCol = (c: number) => Math.max(0, Math.min(grid.cols - 1, c));
  const page = grid.page ?? 10;
  const forward = grid.rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = grid.rtl ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case 'ArrowDown':
      return { ...cell, row: clampRow(cell.row + 1) };
    case 'ArrowUp':
      return { ...cell, row: clampRow(cell.row - 1) };
    case forward:
      return { ...cell, col: clampCol(cell.col + 1) };
    case back:
      return { ...cell, col: clampCol(cell.col - 1) };
    case 'Home':
      return grid.ctrl ? { row: 0, col: 0 } : { ...cell, col: 0 };
    case 'End':
      return grid.ctrl
        ? { row: grid.rows - 1, col: grid.cols - 1 }
        : { ...cell, col: grid.cols - 1 };
    case 'PageDown':
      return { ...cell, row: clampRow(cell.row + page) };
    case 'PageUp':
      return { ...cell, row: clampRow(cell.row - page) };
    default:
      return null;
  }
}

/** The rows a window of `height` px shows at `scrollTop`, with `overscan` either side. */
export function windowOf(
  count: number,
  scrollTop: number,
  height: number,
  rowHeight: number,
  overscan = 8,
): { start: number; end: number } {
  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(height / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
  };
}
