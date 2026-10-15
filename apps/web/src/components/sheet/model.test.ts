/**
 * The spreadsheet's model (D250): columns, staged edits and what they send, selection, the
 * keyboard and the window of drawn rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SheetRow } from '@/api/inventory/types';
import {
  cellValue,
  countStaged,
  DEFAULT_COLUMNS,
  moveCell,
  NO_SELECTION,
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

function row(over: Partial<SheetRow> = {}): SheetRow {
  return {
    id: 'a',
    locationId: 'loc',
    shortCode: 'K7D2QX',
    name: 'Drill',
    type: null,
    quantity: 1,
    lifecycle: 'in_use',
    derivedState: [],
    path: [{ id: 'p1', name: 'Garage', kind: 'place', isUnplaced: false }],
    containerThumbUrl: null,
    thumbUrl: null,
    lastSeenAt: null,
    isContainer: false,
    rowVersion: 3,
    updatedAt: '2026-10-15T10:00:00.000Z',
    placeId: 'p1',
    containerId: null,
    brand: null,
    model: null,
    serial: null,
    barcode: null,
    colour: null,
    condition: null,
    notes: null,
    manualUrl: null,
    expiresOn: null,
    tags: [{ id: 't2', name: 'Red', colour: null }],
    belongsTo: null,
    reviewState: 'confirmed',
    quantityFixed: false,
    purchase: null,
    ...over,
  };
}

const m = {
  nameRequired: 'name',
  tooLong: (n: number) => `max ${n}`,
  quantity: 'quantity',
  quantityFixed: 'fixed',
};

describe('columns', () => {
  it('shows Name first and leaves out what the gate hides', () => {
    const ids = (g: { money: boolean; warranties: boolean }) =>
      visibleColumns(DEFAULT_COLUMNS, g).map((c) => c.id);
    expect(ids({ money: true, warranties: true })).toEqual([...DEFAULT_COLUMNS]);
    expect(ids({ money: false, warranties: true })).not.toContain('price');
    expect(ids({ money: true, warranties: false })).not.toContain('warranty');
    expect(visibleColumns(['serial'], { money: true, warranties: true }).map((c) => c.id)).toEqual([
      'name',
      'serial',
    ]);
  });

  describe('remembered per person', () => {
    beforeEach(() => localStorage.clear());
    it('reads back what was written, per user, and drops unknown ids', () => {
      expect(readColumns('u1')).toBeNull();
      writeColumns('u1', ['name', 'serial', 'notes']);
      expect(readColumns('u1')).toEqual(['name', 'serial', 'notes']);
      expect(readColumns('u2')).toBeNull();
      localStorage.setItem('kept.sheet.columns.u3', JSON.stringify(['serial', 'nope']));
      expect(readColumns('u3')).toEqual(['serial']);
      writeColumns('u1', null);
      expect(readColumns('u1')).toBeNull();
    });
  });
});

describe('staged edits', () => {
  it('stages a change and unstages it when it goes back to the row’s value', () => {
    const r = row();
    let s: Staged = new Map();
    s = stage(s, r, 'name', 'Big drill');
    expect(s.get('a')).toEqual({ rowVersion: 3, draft: { name: 'Big drill' } });
    expect(cellValue(r, s, 'name')).toBe('Big drill');
    // Text is compared trimmed; tags in any order.
    s = stage(s, r, 'name', ' Drill ');
    expect(s.size).toBe(0);
    s = stage(s, r, 'tagIds', ['t2']);
    expect(s.size).toBe(0);
    s = stage(s, r, 'tagIds', ['t3', 't2']);
    expect(s.get('a')?.draft.tagIds).toEqual(['t2', 't3']);
    // "٢" is 2; "1" is the row's own quantity.
    s = stage(s, r, 'quantity', '1');
    expect(s.get('a')?.draft.quantity).toBeUndefined();
    s = stage(s, r, 'quantity', '٢');
    expect(countStaged(s)).toEqual({ cells: 2, rows: 1 });
  });

  it('keeps the version a row was read at, until "Keep mine" rebases it', () => {
    const r = row();
    let s = stage(new Map(), r, 'model', 'X');
    // The row moved on in the cache: the staged version doesn't follow it.
    s = stage(s, { ...r, rowVersion: 9 }, 'serial', 'S');
    expect(s.get('a')?.rowVersion).toBe(3);
    expect(rebase(s, 'a', 9).get('a')?.rowVersion).toBe(9);
    expect(unstage(s, ['a']).size).toBe(0);
  });

  it('checks as the thing form does', () => {
    expect(validateDraft(row(), { name: '  ' }, m)).toEqual({ name: 'name' });
    expect(validateDraft(row(), { model: 'x'.repeat(121) }, m)).toEqual({ model: 'max 120' });
    expect(validateDraft(row(), { quantity: '1.5' }, m)).toEqual({ quantity: 'quantity' });
    expect(validateDraft(row(), { quantity: '-1' }, m)).toEqual({ quantity: 'quantity' });
    expect(validateDraft(row({ quantityFixed: true }), { quantity: '2' }, m)).toEqual({
      quantity: 'fixed',
    });
    expect(validateDraft(row(), { quantity: '٣', serial: 'ok' }, m)).toEqual({});
  });

  it('sends wire types, in row order, 200 a request', () => {
    const a = row();
    const b = row({ id: 'b', rowVersion: 5 });
    let s: Staged = new Map();
    s = stage(s, b, 'model', '  ');
    s = stage(s, b, 'quantity', '٢');
    s = stage(s, a, 'name', ' Big drill ');
    s = stage(s, a, 'to', { containerId: 'box' });
    s = stage(s, a, 'brandId', 'br');
    const b0 = { ...b, model: 'Old' };
    s = stage(s, b0, 'model', '');
    expect(toEdits(s, ['a', 'b'])).toEqual([
      [
        {
          id: 'a',
          rowVersion: 3,
          set: { name: 'Big drill', to: { containerId: 'box' }, brandId: 'br' },
        },
        { id: 'b', rowVersion: 5, set: { quantity: 2, model: null } },
      ],
    ]);
    const many: Staged = new Map(
      Array.from({ length: 450 }, (_, i) => [`r${i}`, { rowVersion: 1, draft: { model: 'M' } }]),
    );
    expect(toEdits(many, []).map((x) => x.length)).toEqual([200, 200, 50]);
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('toggles one row and ranges from the anchor', () => {
    let s = toggleRow(NO_SELECTION, 'b');
    expect([...s.ids]).toEqual(['b']);
    s = selectRange(s, order, 'd');
    expect([...s.ids].sort()).toEqual(['b', 'c', 'd']);
    expect(s.anchor).toBe('b');
    s = selectRange(s, order, 'a');
    expect([...s.ids].sort()).toEqual(['a', 'b', 'c', 'd']);
    s = toggleRow(s, 'c');
    expect([...s.ids].sort()).toEqual(['a', 'b', 'd']);
    expect(s.anchor).toBe('c');
    expect([...selectAll(order).ids]).toEqual(order);
  });
});

describe('keyboard', () => {
  const grid = { rows: 30, cols: 5, rtl: false };
  it('moves with arrows, Home/End and pages, inside the grid', () => {
    expect(moveCell({ row: 0, col: 0 }, 'ArrowDown', grid)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 0, col: 0 }, 'ArrowUp', grid)).toEqual({ row: 0, col: 0 });
    expect(moveCell({ row: 2, col: 1 }, 'ArrowRight', grid)).toEqual({ row: 2, col: 2 });
    expect(moveCell({ row: 2, col: 4 }, 'ArrowRight', grid)).toEqual({ row: 2, col: 4 });
    expect(moveCell({ row: 2, col: 3 }, 'Home', grid)).toEqual({ row: 2, col: 0 });
    expect(moveCell({ row: 2, col: 3 }, 'End', { ...grid, ctrl: true })).toEqual({
      row: 29,
      col: 4,
    });
    expect(moveCell({ row: 25, col: 3 }, 'PageDown', grid)).toEqual({ row: 29, col: 3 });
    expect(moveCell({ row: 0, col: 0 }, 'x', grid)).toBeNull();
  });

  it('mirrors left and right, right to left', () => {
    const rtl = { ...grid, rtl: true };
    expect(moveCell({ row: 0, col: 1 }, 'ArrowLeft', rtl)).toEqual({ row: 0, col: 2 });
    expect(moveCell({ row: 0, col: 1 }, 'ArrowRight', rtl)).toEqual({ row: 0, col: 0 });
  });
});

describe('window', () => {
  it('draws the rows in view and a few either side', () => {
    expect(windowOf(5000, 0, 400, 40)).toEqual({ start: 0, end: 18 });
    expect(windowOf(5000, 40_000, 400, 40)).toEqual({ start: 992, end: 1018 });
    expect(windowOf(12, 0, 4000, 40)).toEqual({ start: 0, end: 12 });
  });
});
