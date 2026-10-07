/**
 * Label stock (D44, D97, D175, D185; plan Q29). Labels are print-styled HTML with `@page` sizes,
 * one sheet per stock, and PNGs made on the phone. All sizes are millimetres; x and y are from
 * the page's physical top-left corner, whatever the reading direction, because the sheet is.
 *
 * The sheet margins and gaps were not checked against a maker's template: they are the common
 * layouts for these sizes, chosen so the cells add up to the page, and they vary a little
 * between makers. The device checklist prints a test sheet on real stock before release.
 * `letter_30_67x25` follows the Avery 5160 layout (1" × 2⅝", 3 × 10).
 */

import type { Names } from './builtin-types.js';

export type LabelStock = {
  readonly key: string;
  readonly names: Names;
  readonly page: { readonly w: number; readonly h: number };
  readonly cols: number;
  readonly rows: number;
  readonly cell: { readonly w: number; readonly h: number };
  readonly gap: { readonly x: number; readonly y: number };
  readonly margin: { readonly top: number; readonly left: number };
  /** `compact`: the QR and the code only, for labels too small for a name. */
  readonly content: 'full' | 'compact';
};

const roll = (key: string, w: number, h: number, en: string, ar: string): LabelStock => ({
  key,
  names: { en, ar },
  page: { w, h },
  cols: 1,
  rows: 1,
  cell: { w, h },
  gap: { x: 0, y: 0 },
  margin: { top: 0, left: 0 },
  content: 'full',
});

export const LABEL_STOCKS: readonly LabelStock[] = Object.freeze([
  roll('thermal_50x30', 50, 30, 'Thermal 50 × 30 mm', 'حراري 50 × 30 مم'),
  roll('thermal_40x30', 40, 30, 'Thermal 40 × 30 mm', 'حراري 40 × 30 مم'),
  roll('thermal_62x29', 62, 29, 'Brother 62 × 29 mm', 'براذر 62 × 29 مم'),
  {
    key: 'a4_24_70x37',
    names: { en: 'A4, 24 labels (70 × 37 mm)', ar: 'A4، ‏24 ملصقًا (70 × 37 مم)' },
    page: { w: 210, h: 297 },
    cols: 3,
    rows: 8,
    cell: { w: 70, h: 37 },
    gap: { x: 0, y: 0 },
    margin: { top: 0.5, left: 0 },
    content: 'full',
  },
  {
    key: 'a4_65_38x21',
    names: { en: 'A4, 65 labels (38 × 21 mm)', ar: 'A4، ‏65 ملصقًا (38 × 21 مم)' },
    page: { w: 210, h: 297 },
    cols: 5,
    rows: 13,
    cell: { w: 38.1, h: 21.2 },
    gap: { x: 2.5, y: 0 },
    margin: { top: 10.7, left: 4.75 },
    content: 'compact',
  },
  {
    key: 'letter_30_67x25',
    names: { en: 'Letter, 30 labels (Avery 5160)', ar: 'Letter، ‏30 ملصقًا (Avery 5160)' },
    page: { w: 215.9, h: 279.4 },
    cols: 3,
    rows: 10,
    cell: { w: 66.675, h: 25.4 },
    gap: { x: 3.175, y: 0 },
    margin: { top: 12.7, left: 4.7625 },
    content: 'full',
  },
]);

export function labelStock(key: string): LabelStock {
  const stock = LABEL_STOCKS.find((s) => s.key === key);
  if (!stock) throw new RangeError(`unknown label stock "${key}"`);
  return stock;
}

/** A sheet has several labels per page; a roll has one, and no start cell. */
export function isSheet(stock: LabelStock): boolean {
  return stock.cols * stock.rows > 1;
}

export type LabelCell = {
  /** 0-based page. */
  page: number;
  /** 0-based cell on the page, row by row. */
  cell: number;
  col: number;
  row: number;
  /** The cell's top-left corner, mm from the page's top-left. */
  x: number;
  y: number;
};

/**
 * Where `count` labels go. `startCell` is 1-based, as the grid picker shows it (D175), and
 * applies to sheets only: on a part-used sheet the cells before it stay empty on the first
 * page. On a roll every label is its own page.
 */
export function cellsFor(
  stock: LabelStock,
  count: number,
  startCell = 1,
): { pages: number; cells: LabelCell[] } {
  const perPage = stock.cols * stock.rows;
  const sheet = perPage > 1;
  if (sheet && (!Number.isInteger(startCell) || startCell < 1 || startCell > perPage)) {
    throw new RangeError(`start cell must be 1–${perPage}, got ${startCell}`);
  }
  const offset = sheet ? startCell - 1 : 0;
  const cells: LabelCell[] = [];
  for (let i = 0; i < count; i++) {
    const n = offset + i;
    const page = Math.floor(n / perPage);
    const cell = n % perPage;
    const row = Math.floor(cell / stock.cols);
    const col = cell % stock.cols;
    cells.push({
      page,
      cell,
      col,
      row,
      x: stock.margin.left + col * (stock.cell.w + stock.gap.x),
      y: stock.margin.top + row * (stock.cell.h + stock.gap.y),
    });
  }
  return { pages: count === 0 ? 0 : (cells[cells.length - 1] as LabelCell).page + 1, cells };
}
