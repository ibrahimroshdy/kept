import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvDocument, csvLine, safeCsvCell } from './csv-safe.js';

describe('safeCsvCell (D169)', () => {
  it.each([
    ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['+1', "'+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
  ])('neutralises %j', (input, out) => {
    expect(safeCsvCell(input)).toBe(out);
  });

  it('neutralises a negative number, which a spreadsheet would evaluate', () => {
    expect(safeCsvCell(-12.5)).toBe("'-12.5");
  });

  it('quotes a comma, a quote and a line break, and leaves plain text alone', () => {
    expect(safeCsvCell('a,b')).toBe('"a,b"');
    expect(safeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(safeCsvCell('two\nlines')).toBe('"two\nlines"');
    expect(safeCsvCell('Drill 18V')).toBe('Drill 18V');
    expect(safeCsvCell('a=b')).toBe('a=b');
  });

  it('keeps Arabic text as it is', () => {
    expect(safeCsvCell('مثقاب كهربائي')).toBe('مثقاب كهربائي');
    expect(safeCsvCell('ثلاجة، المطبخ')).toBe('ثلاجة، المطبخ');
  });

  it('writes null and undefined as empty, numbers and booleans as text', () => {
    expect(safeCsvCell(null)).toBe('');
    expect(safeCsvCell(undefined)).toBe('');
    expect(safeCsvCell(42)).toBe('42');
    expect(safeCsvCell(true)).toBe('true');
  });
});

describe('csvLine and csvDocument', () => {
  it('joins cells with commas and rows with CRLF after a BOM', () => {
    expect(csvLine(['a', '=1', null, 'x,y'])).toBe(`a,'=1,,"x,y"`);
    expect(CSV_BOM).toBe('﻿');
    expect(
      csvDocument([
        ['name', 'place'],
        ['Drill', 'Garage'],
      ]),
    ).toBe('﻿name,place\r\nDrill,Garage\r\n');
  });
});
