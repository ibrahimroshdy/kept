/**
 * Reading the file (T30, Q18): papaparse on this device, UTF-8 with the byte-order mark dropped,
 * unique non-blank headers, one cell per column, and the server's limits refused before anything
 * is sent (10,000 rows, 8 MB, 200 columns, 10,000 characters a cell).
 */
import { describe, expect, it } from 'vitest';
import { ParseError, type ParseProblem, parseCsvFile, uniqueColumns } from './parse';

const blank = (n: number) => `Column ${n}`;
const csv = (text: string) => new Blob([text], { type: 'text/csv' });

async function problemOf(file: Blob): Promise<ParseProblem | null> {
  try {
    await parseCsvFile(file, blank);
    return null;
  } catch (e) {
    return e instanceof ParseError ? e.problem : null;
  }
}

describe('parseCsvFile', () => {
  it('drops the byte-order mark, keeps quoted commas and newlines, and never types a cell', async () => {
    const parsed = await parseCsvFile(
      csv('﻿الاسم,المكان,Qty\n"Kettle, red",المطبخ > الرف,٣٤٥\n"Two\nlines",Garage,007\n'),
      blank,
    );
    expect(parsed.columns).toEqual(['الاسم', 'المكان', 'Qty']);
    expect(parsed.rows).toEqual([
      ['Kettle, red', 'المطبخ > الرف', '٣٤٥'],
      ['Two\nlines', 'Garage', '007'],
    ]);
  });

  it('keeps a formula-looking cell as the text it is', async () => {
    const parsed = await parseCsvFile(csv('Name\n"=HYPERLINK(""x"")"\n'), blank);
    expect(parsed.rows).toEqual([['=HYPERLINK("x")']]);
  });

  it('names blank headers, numbers repeats, and gives every row one cell per column', async () => {
    const parsed = await parseCsvFile(csv('Name,,Name\nA,b\nC,d,e,f\n'), blank);
    expect(parsed.columns).toEqual(['Name', 'Column 2', 'Name (2)', 'Column 4']);
    expect(parsed.rows).toEqual([
      ['A', 'b', '', ''],
      ['C', 'd', 'e', 'f'],
    ]);
  });

  it('skips blank lines', async () => {
    const parsed = await parseCsvFile(csv('Name\n\nA\n   \nB\n'), blank);
    expect(parsed.rows).toEqual([['A'], ['B']]);
  });

  it('refuses 10,001 rows before anything is sent, and takes 10,000', async () => {
    const lines = (n: number) =>
      `Name\n${Array.from({ length: n }, (_, i) => `Thing ${i}`).join('\n')}\n`;
    expect(await problemOf(csv(lines(10_001)))).toEqual({ kind: 'too_many_rows', rows: 10_001 });
    expect((await parseCsvFile(csv(lines(10_000)), blank)).rows).toHaveLength(10_000);
  });

  it('refuses a file over 8 MB, over 200 columns, a cell over 10,000 characters, and no rows', async () => {
    const big = { size: 8_000_001, text: async () => '' } as unknown as Blob;
    expect(await problemOf(big)).toEqual({ kind: 'too_big', bytes: 8_000_001 });
    const wide = Array.from({ length: 201 }, (_, i) => `c${i}`).join(',');
    expect(await problemOf(csv(`${wide}\n${wide}\n`))).toEqual({
      kind: 'too_many_columns',
      columns: 201,
    });
    expect(await problemOf(csv(`Name,Notes\nA,${'x'.repeat(10_001)}\n`))).toEqual({
      kind: 'cell_too_long',
      row: 1,
      column: 'Notes',
    });
    expect(await problemOf(csv('Name\n'))).toEqual({ kind: 'empty' });
  });
});

describe('uniqueColumns', () => {
  it('cuts a header to the server limit and keeps it unique', () => {
    const long = 'x'.repeat(300);
    const cols = uniqueColumns([long, long], blank);
    expect(cols[0]?.length).toBeLessThanOrEqual(200);
    expect(cols[1]).toBe(`${cols[0]} (2)`);
  });
});
