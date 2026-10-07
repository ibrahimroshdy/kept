/**
 * Label geometry (plan T28): where each label lands per stock, the start cell on a part-used
 * sheet, how many pages a batch takes, the `@page` rule, and that the code always fits its column.
 */
import { LABEL_STOCKS, labelStock } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import type { LabelCellContent } from '@/api/capture/types';
import { cellMetrics, directionOfText, pageCss, pagesFor, placeLabels, rowColOf } from './layout';

const labels = (n: number): LabelCellContent[] =>
  Array.from({ length: n }, (_, i) => {
    const code = `A${String(i).padStart(5, '0')}`;
    return { code, url: `https://kept.example/l/${code}`, kind: 'thing', name: `Box ${i + 1}` };
  });

describe('placeLabels per stock', () => {
  it.each(LABEL_STOCKS.map((s) => [s.key] as const))('%s: the first page, cell by cell', (key) => {
    const stock = labelStock(key);
    const pages = placeLabels(stock, labels(stock.cols * stock.rows));
    expect(pages).toHaveLength(1);
    const first = pages[0] ?? [];
    const cell = (i: number) => {
      const c = first[i]?.cell;
      return c && { cell: c.cell, col: c.col, row: c.row, x: +c.x.toFixed(3), y: +c.y.toFixed(3) };
    };
    expect({
      page: pageCss(stock),
      cells: first.length,
      first: cell(0),
      second: cell(1),
      last: cell(first.length - 1),
    }).toMatchSnapshot();
  });

  it('a roll puts every label on its own page and ignores the start cell', () => {
    const stock = labelStock('thermal_40x30');
    const pages = placeLabels(stock, labels(3), 7);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.map((l) => l.cell.cell))).toEqual([[0], [0], [0]]);
    expect(pagesFor(stock, 3, 7)).toBe(3);
  });
});

describe('the start cell (D175)', () => {
  const a4 = labelStock('a4_24_70x37');

  it('start cell 20 leaves the first 19 cells of the first sheet empty', () => {
    const [first] = placeLabels(a4, labels(5), 20);
    expect(first?.map((l) => l.cell.cell + 1)).toEqual([20, 21, 22, 23, 24]);
    expect(first?.[0]?.label.code).toBe('A00000');
    expect(rowColOf(a4, 20)).toEqual({ row: 7, col: 2 });
  });

  it('30 labels from cell 20 take 3 sheets: 5, 24, then 1', () => {
    const pages = placeLabels(a4, labels(30), 20);
    expect(pages.map((p) => p.length)).toEqual([5, 24, 1]);
    expect(pagesFor(a4, 30, 20)).toBe(3);
    expect(pagesFor(a4, 29, 20)).toBe(2);
    expect(pages[1]?.[0]?.cell).toMatchObject({ cell: 0, x: 0, y: 0.5 });
  });

  it('no labels, no pages', () => {
    expect(placeLabels(a4, [], 20)).toEqual([]);
    expect(pagesFor(a4, 0, 20)).toBe(0);
  });
});

describe('cellMetrics', () => {
  it.each(LABEL_STOCKS.map((s) => [s.key] as const))('%s: the parts fit the cell', (key) => {
    const stock = labelStock(key);
    const m = cellMetrics(stock);
    expect(m.pad * 3 + m.qr + m.text).toBeCloseTo(stock.cell.w, 5);
    expect(m.qr).toBeLessThanOrEqual(stock.cell.h - 2 * m.pad + 1e-9);
    // Seven mono characters at 0.66 em (the advance plus the tracking) fit the column.
    expect(m.code * 7 * 0.66).toBeLessThanOrEqual(m.text + 1e-9);
    // A QR module stays at or above 0.4 mm for a 40-character URL (version 3, 37 modules).
    expect(m.qr / 37).toBeGreaterThanOrEqual(0.4);
  });

  it('prints names and paths except on the compact stock', () => {
    expect(LABEL_STOCKS.filter((s) => cellMetrics(s).compact).map((s) => s.key)).toEqual([
      'a4_65_38x21',
    ]);
  });
});

describe('directionOfText', () => {
  it('follows the first strong letter', () => {
    expect(directionOfText('بيت العائلة')).toBe('rtl');
    expect(directionOfText('3 صناديق')).toBe('rtl');
    expect(directionOfText('Box 3 — صندوق')).toBe('ltr');
    expect(directionOfText('2026')).toBe('ltr');
  });
});
