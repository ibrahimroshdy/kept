import { describe, expect, it } from 'vitest';
import { cellsFor, isSheet, LABEL_STOCKS, labelStock } from './label-stocks.js';

describe('LABEL_STOCKS (D44, Q29)', () => {
  it('has the six stocks, in order', () => {
    expect(LABEL_STOCKS.map((s) => s.key)).toEqual([
      'thermal_50x30',
      'thermal_40x30',
      'thermal_62x29',
      'a4_24_70x37',
      'a4_65_38x21',
      'letter_30_67x25',
    ]);
  });

  it.each(LABEL_STOCKS.map((s) => [s.key, s] as const))('%s fits its page', (_key, s) => {
    const width = s.margin.left * 2 + s.cols * s.cell.w + (s.cols - 1) * s.gap.x;
    const height = s.margin.top + s.rows * s.cell.h + (s.rows - 1) * s.gap.y;
    expect(width).toBeCloseTo(s.page.w, 1);
    expect(height).toBeLessThanOrEqual(s.page.h + 0.01);
    expect(s.names.en).toBeTruthy();
    expect(s.names.ar).toBeTruthy();
  });

  it('prints QR and code only on the small A4 stock', () => {
    expect(LABEL_STOCKS.filter((s) => s.content === 'compact').map((s) => s.key)).toEqual([
      'a4_65_38x21',
    ]);
  });
});

describe('cellsFor', () => {
  // The plan's example says 30 labels from start cell 20 "take 2 pages", but cells 20–24 hold 5
  // and a full sheet 24: 29 fit on two pages, and the 30th starts a third.
  it('fills a4_24 from start cell 20: the first 19 cells stay empty, 29 labels fit on 2 pages', () => {
    const stock = labelStock('a4_24_70x37');
    const two = cellsFor(stock, 29, 20);
    expect(two.pages).toBe(2);
    expect(two.cells[0]).toMatchObject({ page: 0, cell: 19, col: 1, row: 6 });
    expect(two.cells[4]).toMatchObject({ page: 0, cell: 23, col: 2, row: 7 });
    expect(two.cells[5]).toMatchObject({ page: 1, cell: 0, col: 0, row: 0 });
    expect(two.cells[28]).toMatchObject({ page: 1, cell: 23 });
    const three = cellsFor(stock, 30, 20);
    expect(three.pages).toBe(3);
    expect(three.cells[29]).toMatchObject({ page: 2, cell: 0 });
  });

  it('places cells in millimetres from the page’s top-left corner', () => {
    const stock = labelStock('letter_30_67x25');
    const { cells } = cellsFor(stock, 4);
    expect(cells[0]).toMatchObject({ x: 4.7625, y: 12.7 });
    expect(cells[1]?.x).toBeCloseTo(4.7625 + 66.675 + 3.175, 6);
    expect(cells[3]).toMatchObject({ col: 0, row: 1 });
    expect(cells[3]?.y).toBeCloseTo(12.7 + 25.4, 6);
  });

  it('ignores the start cell on thermal rolls: one label per page', () => {
    const { pages, cells } = cellsFor(labelStock('thermal_50x30'), 3, 7);
    expect(pages).toBe(3);
    expect(cells.map((c) => [c.page, c.cell, c.x, c.y])).toEqual([
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    expect(isSheet(labelStock('thermal_50x30'))).toBe(false);
    expect(isSheet(labelStock('a4_24_70x37'))).toBe(true);
  });

  it('refuses a start cell off the sheet and an unknown stock', () => {
    expect(() => cellsFor(labelStock('a4_24_70x37'), 1, 25)).toThrow(RangeError);
    expect(() => cellsFor(labelStock('a4_24_70x37'), 1, 0)).toThrow(RangeError);
    expect(() => labelStock('a5_nope')).toThrow(RangeError);
    expect(cellsFor(labelStock('a4_24_70x37'), 0)).toEqual({ pages: 0, cells: [] });
  });
});
